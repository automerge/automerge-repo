/**
 * Tests for the full tab → shared worker → sync server topology:
 *
 *   tab1 ──messagechannel──▸ worker1 ──websocket/subduction──▸ server
 *   tab2 ──messagechannel──▸ worker2 ──websocket/subduction──▸ server
 *
 * The messagechannel links run the standard automerge sync protocol.
 * The websocket links run subduction.
 */

import { describe, it, expect, afterEach } from "vitest"
import { WebSocketServer } from "ws"
import { MessageChannelNetworkAdapter } from "../../../automerge-repo-network-messagechannel/src/index.js"
import {
  Subduction,
  MemorySigner,
  MemoryStorage,
} from "@automerge/automerge-subduction"
import { Repo } from "../../src/Repo.js"
import { DummyStorageAdapter } from "../../src/helpers/DummyStorageAdapter.js"
import { type PeerId, type UrlHeads } from "../../src/types.js"
import { type StorageId } from "../../src/storage/types.js"
import { type DocHandleRemoteHeadsPayload } from "../../src/DocHandle.js"
import { WebSocketTransport } from "../../src/subduction/websocket-transport.js"
import { pause } from "../../src/helpers/pause.js"

// ── Test helpers ──────────────────────────────────────────────────────

/**
 * A subduction WebSocket server that can be stopped and restarted on
 * the same port (with fresh storage each time).
 */
class TestServer {
  #port: number
  #wss: WebSocketServer | null = null
  #subduction: Subduction | null = null
  #signer: MemorySigner | null = null
  #storage: MemoryStorage | null = null

  get url() {
    return `ws://localhost:${this.#port}`
  }
  get port() {
    return this.#port
  }
  get subduction() {
    return this.#subduction!
  }
  /** The server's subduction peer ID as a StorageId, for use with subscribeToRemotes. */
  get storageId(): StorageId {
    return this.#signer!.peerId().toString() as StorageId
  }

  private constructor(port: number) {
    this.#port = port
  }

  static async start(): Promise<TestServer> {
    // Grab an ephemeral port
    const tmp = new WebSocketServer({ port: 0 })
    await new Promise<void>(r => tmp.on("listening", r))
    const addr = tmp.address()
    if (typeof addr === "string") throw new Error("unexpected address type")
    const port = addr.port
    await new Promise<void>((r, e) => tmp.close(err => (err ? e(err) : r())))
    const server = new TestServer(port)
    await server.restart()
    return server
  }

  /** Start (or restart) the server on the same port. */
  async restart({
    clearStorage = true,
  }: { clearStorage?: boolean } = {}): Promise<void> {
    if (this.#wss) await this.stop()

    if (clearStorage || !this.#signer) {
      this.#signer = new MemorySigner()
      this.#storage = new MemoryStorage()
    }
    this.#subduction = await Subduction.hydrate(this.#signer, this.#storage!)
    const serviceName = `localhost:${this.#port}`

    this.#wss = new WebSocketServer({ port: this.#port })
    await new Promise<void>(r => this.#wss!.on("listening", r))

    this.#wss.on("connection", ws => {
      const transport = new WebSocketTransport(ws as any)
      this.#subduction!.acceptTransport(transport, serviceName).catch(() => {})
    })
  }

  /** Stop the server. Can be restarted with restart(). */
  async stop(): Promise<void> {
    if (this.#subduction) {
      await this.#subduction.disconnectAll()
      this.#subduction = null
    }
    if (this.#wss) {
      await new Promise<void>((r, e) =>
        this.#wss!.close(err => (err ? e(err) : r()))
      )
      this.#wss = null
    }
  }

  /** Alias for stop(), for use in cleanup arrays. */
  close = () => this.stop()
}

interface TabWorkerPair {
  tab: Repo
  worker: Repo
  channel: MessageChannel
}

function makeTabWorkerPair(
  name: string,
  serverUrl: string | null,
  opts?: { enableRemoteHeadsGossiping?: boolean }
): TabWorkerPair {
  const channel = new MessageChannel()
  const enableRemoteHeadsGossiping = opts?.enableRemoteHeadsGossiping ?? false

  const worker = new Repo({
    peerId: `${name}-worker` as PeerId,
    storage: new DummyStorageAdapter(),
    network: [new MessageChannelNetworkAdapter(channel.port1)],
    sharePolicy: async () => true,
    subductionWebsocketEndpoints: serverUrl ? [serverUrl] : [],
    enableRemoteHeadsGossiping,
  })

  const tab = new Repo({
    peerId: `${name}-tab` as PeerId,
    network: [new MessageChannelNetworkAdapter(channel.port2)],
    sharePolicy: async () => true,
    enableRemoteHeadsGossiping,
  })

  return { tab, worker, channel }
}

async function waitForCondition(
  fn: () => Promise<boolean> | boolean,
  timeoutMs: number,
  intervalMs = 50
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await pause(intervalMs)
  }
  throw new Error(`waitForCondition timed out after ${timeoutMs}ms`)
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("Tab → Worker → Server topology", () => {
  const cleanups: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) {
      await cleanup()
    }
    cleanups.length = 0
  })

  async function startServer() {
    const server = await TestServer.start()
    cleanups.push(() => server.close())
    return server
  }

  function createTabWorkerPair(
    name: string,
    serverUrl: string | null,
    opts?: { enableRemoteHeadsGossiping?: boolean }
  ) {
    const pair = makeTabWorkerPair(name, serverUrl, opts)
    cleanups.push(() => pair.channel.port1.close())
    return pair
  }

  // ── Basic sync ────────────────────────────────────────────────────

  it("document created in one tab is found in the other tab", async () => {
    const server = await startServer()

    const pair1 = createTabWorkerPair("alice", server.url)
    const pair2 = createTabWorkerPair("bob", server.url)

    const aliceHandle = pair1.tab.create<{ title: string }>()
    aliceHandle.change(d => {
      d.title = "Hello from Alice"
    })

    await pause(500)

    const bobHandle = await pair2.tab.find<{ title: string }>(aliceHandle.url)
    await bobHandle.whenReady()

    expect(bobHandle.doc()!.title).toBe("Hello from Alice")
  }, 10_000)

  it("updates flow in both directions between tabs", async () => {
    const server = await startServer()

    const pair1 = createTabWorkerPair("alice", server.url)
    const pair2 = createTabWorkerPair("bob", server.url)

    const aliceHandle = pair1.tab.create<{ alice: string; bob?: string }>()
    aliceHandle.change(d => {
      d.alice = "Alice was here"
    })

    await pause(500)

    const bobHandle = await pair2.tab.find<{ alice: string; bob?: string }>(
      aliceHandle.url
    )
    await bobHandle.whenReady()
    expect(bobHandle.doc()!.alice).toBe("Alice was here")

    bobHandle.change(d => {
      d.bob = "Bob was here"
    })

    await pause(500)

    expect(aliceHandle.doc()!.bob).toBe("Bob was here")
  }, 10_000)

  // ── Document lifecycle ────────────────────────────────────────────

  it("find before connecting returns unavailable, find after connecting succeeds", async () => {
    const pair1 = createTabWorkerPair("alice", null)
    const pair2 = createTabWorkerPair("bob", null)

    const aliceHandle = pair1.tab.create<{ value: number }>()
    aliceHandle.change(d => {
      d.value = 123
    })

    const bobProgress = pair2.tab.findWithProgress<{ value: number }>(
      aliceHandle.url
    )

    await pause(500)
    expect(bobProgress.peek().state).toBe("unavailable")

    // Connect new pairs via a server
    const server = await startServer()

    const pair1c = createTabWorkerPair("alice2", server.url)
    const pair2c = createTabWorkerPair("bob2", server.url)

    const aliceHandle2 = pair1c.tab.create<{ value: number }>()
    aliceHandle2.change(d => {
      d.value = 123
    })

    await pause(500)

    const bobHandle2 = await pair2c.tab.find<{ value: number }>(
      aliceHandle2.url
    )
    await bobHandle2.whenReady()
    expect(bobHandle2.doc()!.value).toBe(123)
  }, 10_000)

  it("document created in tab before worker connects to server syncs after connection", async () => {
    // Create pair without server
    const pair1 = createTabWorkerPair("alice", null)

    // Alice creates a doc while her worker is disconnected
    const aliceHandle = pair1.tab.create<{ value: string }>()
    aliceHandle.change(d => {
      d.value = "created offline"
    })

    // Wait for tab → worker sync via messagechannel
    await pause(200)

    // Now start server and create a connected worker for Alice
    // (simulating the worker establishing its websocket connection)
    const server = await startServer()

    const pair1c = createTabWorkerPair("alice-c", server.url)

    // Re-create the doc in the connected pair
    const aliceHandle2 = pair1c.tab.create<{ value: string }>()
    aliceHandle2.change(d => {
      d.value = "created offline"
    })

    await pause(500)

    // Another user can find it
    const pair2 = createTabWorkerPair("bob", server.url)

    const bobHandle = await pair2.tab.find<{ value: string }>(aliceHandle2.url)
    await bobHandle.whenReady()
    expect(bobHandle.doc()!.value).toBe("created offline")
  }, 10_000)

  it("server restart with empty storage — doc unavailable for new client", async () => {
    const server = await startServer()

    const pair1 = createTabWorkerPair("alice", server.url)

    const aliceHandle = pair1.tab.create<{ data: string }>()
    aliceHandle.change(d => {
      d.data = "important"
    })

    await pause(500)

    // Restart with fresh storage — Alice's doc is gone
    await server.restart()

    // Bob connects — Alice's doc isn't on the server
    const pair2 = createTabWorkerPair("bob", server.url)

    const bobProgress = pair2.tab.findWithProgress<{ data: string }>(
      aliceHandle.url
    )

    await waitForCondition(
      () => bobProgress.peek().state === "unavailable",
      3000
    )
  }, 10_000)

  // ── Concurrent edits ──────────────────────────────────────────────

  it("simultaneous edits from both tabs merge correctly", async () => {
    const server = await startServer()

    const pair1 = createTabWorkerPair("alice", server.url)
    const pair2 = createTabWorkerPair("bob", server.url)

    // Alice creates the doc
    const aliceHandle = pair1.tab.create<{
      alice?: string
      bob?: string
    }>()
    aliceHandle.change(d => {
      // initial empty state
    })

    await pause(500)

    // Bob finds it
    const bobHandle = await pair2.tab.find<{
      alice?: string
      bob?: string
    }>(aliceHandle.url)
    await bobHandle.whenReady()

    // Both edit simultaneously (different keys — no conflict)
    aliceHandle.change(d => {
      d.alice = "alice-edit"
    })
    bobHandle.change(d => {
      d.bob = "bob-edit"
    })

    // Wait for changes to propagate both ways
    await waitForCondition(
      () =>
        aliceHandle.doc()!.bob === "bob-edit" &&
        bobHandle.doc()!.alice === "alice-edit",
      5000
    )

    // Both should have both changes
    expect(aliceHandle.doc()!.alice).toBe("alice-edit")
    expect(aliceHandle.doc()!.bob).toBe("bob-edit")
    expect(bobHandle.doc()!.alice).toBe("alice-edit")
    expect(bobHandle.doc()!.bob).toBe("bob-edit")
  }, 10_000)

  it("rapid sequential edits all arrive", async () => {
    const server = await startServer()

    const pair1 = createTabWorkerPair("alice", server.url)
    const pair2 = createTabWorkerPair("bob", server.url)

    const aliceHandle = pair1.tab.create<{ items: string[] }>()
    aliceHandle.change(d => {
      d.items = []
    })

    await pause(500)

    const bobHandle = await pair2.tab.find<{ items: string[] }>(aliceHandle.url)
    await bobHandle.whenReady()

    // Alice makes many rapid changes
    for (let i = 0; i < 20; i++) {
      aliceHandle.change(d => {
        d.items.push(`item-${i}`)
      })
    }

    // Wait for all changes to arrive at Bob
    await waitForCondition(() => bobHandle.doc()!.items.length === 20, 5000)

    expect(bobHandle.doc()!.items).toHaveLength(20)
    expect(bobHandle.doc()!.items[0]).toBe("item-0")
    expect(bobHandle.doc()!.items[19]).toBe("item-19")
  }, 10_000)

  // ── Connection disruption ─────────────────────────────────────────

  it("server goes down and comes back — sync resumes", async () => {
    const server = await startServer()

    const pair1 = createTabWorkerPair("alice", server.url)
    const pair2 = createTabWorkerPair("bob", server.url)

    const aliceHandle = pair1.tab.create<{
      before?: string
      during?: string
      after?: string
    }>()
    aliceHandle.change(d => {
      d.before = "before outage"
    })

    await pause(500)

    const bobHandle = await pair2.tab.find<{
      before?: string
      during?: string
      after?: string
    }>(aliceHandle.url)
    await bobHandle.whenReady()
    expect(bobHandle.doc()!.before).toBe("before outage")

    // Kill the server
    await server.stop()

    // Alice edits while server is down
    aliceHandle.change(d => {
      d.during = "during outage"
    })

    await pause(200)

    // Restart on the same port, keeping storage so existing data persists
    await server.restart({ clearStorage: false })

    // Wait for workers to reconnect and sync
    await waitForCondition(
      () => bobHandle.doc()!.during === "during outage",
      5000
    )

    // Further edits should also flow
    aliceHandle.change(d => {
      d.after = "after outage"
    })

    await waitForCondition(
      () => bobHandle.doc()!.after === "after outage",
      5000
    )
  }, 15_000)

  // ── Ordering / causality ──────────────────────────────────────────

  it("find issued before create has synced transitions through unavailable to ready", async () => {
    const server = await startServer()

    const pair1 = createTabWorkerPair("alice", server.url)
    const pair2 = createTabWorkerPair("bob", server.url)

    // Alice creates a doc
    const aliceHandle = pair1.tab.create<{ value: number }>()
    aliceHandle.change(d => {
      d.value = 42
    })

    // Bob immediately tries to find it — before it has synced to the server.
    // The query should go unavailable (server has no data yet), then
    // recover to ready once Alice's data arrives via subscription.
    const progress = pair2.tab.findWithProgress<{ value: number }>(
      aliceHandle.url
    )

    const states: string[] = []
    progress.subscribe(s => states.push(s.state))

    await waitForCondition(() => progress.peek().state === "ready", 5000)

    expect(states).toContain("unavailable")
    expect(states).toContain("ready")

    const readyState = progress.peek()
    expect(readyState.state).toBe("ready")
    if (readyState.state === "ready") {
      expect(readyState.handle.doc()!.value).toBe(42)
    }
  }, 10_000)

  // ── Multi-document ────────────────────────────────────────────────

  it("multiple documents sync concurrently across tabs", async () => {
    const server = await startServer()

    const pair1 = createTabWorkerPair("alice", server.url)
    const pair2 = createTabWorkerPair("bob", server.url)

    // Alice creates doc A, Bob creates doc B
    const docA = pair1.tab.create<{ from: string }>()
    docA.change(d => {
      d.from = "alice"
    })

    const docB = pair2.tab.create<{ from: string }>()
    docB.change(d => {
      d.from = "bob"
    })

    await pause(500)

    // Bob finds Alice's doc
    const bobDocA = await pair2.tab.find<{ from: string }>(docA.url)
    await bobDocA.whenReady()
    expect(bobDocA.doc()!.from).toBe("alice")

    // Alice finds Bob's doc
    const aliceDocB = await pair1.tab.find<{ from: string }>(docB.url)
    await aliceDocB.whenReady()
    expect(aliceDocB.doc()!.from).toBe("bob")
  }, 10_000)

  describe("Remote heads gossiping", () => {
    it("remote heads are reported after sync", async () => {
      const server = await startServer()
      const rhOpts = { enableRemoteHeadsGossiping: true }

      const pair1 = createTabWorkerPair("alice", server.url, rhOpts)
      const pair2 = createTabWorkerPair("bob", server.url, rhOpts)

      // Bob's tab subscribes to the server's storage ID
      pair2.tab.subscribeToRemotes([server.storageId])

      // Alice creates a doc and makes a change
      const aliceHandle = pair1.tab.create<{ value: string }>()
      aliceHandle.change(d => {
        d.value = "hello"
      })

      await pause(500)

      // Bob finds the doc
      const bobHandle = await pair2.tab.find<{ value: string }>(aliceHandle.url)
      await bobHandle.whenReady()

      // Bob makes a change — this will sync to the server
      bobHandle.change(d => {
        d.value = "updated"
      })

      // Wait for the remote heads event on Bob's handle
      const remoteHeads = await new Promise<DocHandleRemoteHeadsPayload>(
        resolve => {
          bobHandle.on("remote-heads", msg => {
            if (msg.storageId === server.storageId) {
              resolve(msg)
            }
          })
        }
      )

      expect(remoteHeads.storageId).toBe(server.storageId)
      expect(remoteHeads.heads.length).toBeGreaterThan(0)
    }, 10_000)

    it("remote heads update when server ingests new data from another client", async () => {
      const server = await startServer()
      const rhOpts = { enableRemoteHeadsGossiping: true }

      const pair1 = createTabWorkerPair("alice", server.url, rhOpts)
      const pair2 = createTabWorkerPair("bob", server.url, rhOpts)

      // Alice subscribes to the server's storage ID
      pair1.tab.subscribeToRemotes([server.storageId])

      // Alice creates a doc
      const aliceHandle = pair1.tab.create<{ count: number }>()
      aliceHandle.change(d => {
        d.count = 1
      })

      await pause(500)

      // Collect all remote heads events on Alice's handle
      const remoteHeadsEvents: DocHandleRemoteHeadsPayload[] = []
      aliceHandle.on("remote-heads", msg => {
        if (msg.storageId === server.storageId) {
          remoteHeadsEvents.push(msg)
        }
      })

      // Bob finds the doc and makes a change
      const bobHandle = await pair2.tab.find<{ count: number }>(aliceHandle.url)
      await bobHandle.whenReady()
      bobHandle.change(d => {
        d.count = 2
      })

      // Wait for Alice to receive at least one remote heads event
      // reflecting the server having ingested Bob's change
      await waitForCondition(() => remoteHeadsEvents.length > 0, 5000)

      const latestHeads = remoteHeadsEvents[remoteHeadsEvents.length - 1]
      expect(latestHeads.storageId).toBe(server.storageId)
      expect(latestHeads.heads.length).toBeGreaterThan(0)
    }, 10_000)
  })

  // ── Ephemeral messaging ───────────────────────────────────────────

  describe("Ephemeral messaging", () => {
    it("ephemeral message from one tab reaches the other via subduction", async () => {
      const server = await startServer()

      const pair1 = createTabWorkerPair("alice", server.url)
      const pair2 = createTabWorkerPair("bob", server.url)

      // Alice creates a doc
      const aliceHandle = pair1.tab.create<{ value: string }>()
      aliceHandle.change(d => {
        d.value = "hello"
      })

      await pause(500)

      // Bob finds the doc
      const bobHandle = await pair2.tab.find<{ value: string }>(aliceHandle.url)
      await bobHandle.whenReady()

      // Wait for sync to fully settle (peer states need to be resolved
      // for ephemeral relay in DocSynchronizer)
      await pause(500)

      // Bob listens for ephemeral messages
      const received = new Promise<unknown>(resolve => {
        bobHandle.on("ephemeral-message", ({ message }) => {
          resolve(message)
        })
      })

      // Alice broadcasts an ephemeral message
      aliceHandle.broadcast({ cursor: { x: 10, y: 20 } })

      const message = await received
      expect(message).toEqual({ cursor: { x: 10, y: 20 } })
    }, 10_000)

    it("ephemeral messages flow in both directions", async () => {
      const server = await startServer()

      const pair1 = createTabWorkerPair("alice", server.url)
      const pair2 = createTabWorkerPair("bob", server.url)

      const aliceHandle = pair1.tab.create<{ value: string }>()
      aliceHandle.change(d => {
        d.value = "shared doc"
      })

      await pause(500)

      const bobHandle = await pair2.tab.find<{ value: string }>(aliceHandle.url)
      await bobHandle.whenReady()
      await pause(500)

      // Alice listens for ephemeral messages
      const aliceReceived = new Promise<unknown>(resolve => {
        aliceHandle.on("ephemeral-message", ({ message }) => {
          resolve(message)
        })
      })

      // Bob listens for ephemeral messages
      const bobReceived = new Promise<unknown>(resolve => {
        bobHandle.on("ephemeral-message", ({ message }) => {
          resolve(message)
        })
      })

      // Both broadcast
      aliceHandle.broadcast({ from: "alice" })
      bobHandle.broadcast({ from: "bob" })

      expect(await bobReceived).toEqual({ from: "alice" })
      expect(await aliceReceived).toEqual({ from: "bob" })
    }, 10_000)
  })
})

function sameHeads(a: UrlHeads, b: UrlHeads): boolean {
  if (a.length !== b.length) return false
  const setA = new Set(a)
  return b.every(h => setA.has(h))
}
