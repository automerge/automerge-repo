/**
 * Tests for subduction tunneling over NetworkAdapterInterface.
 *
 * Instead of using the raw WebSocketTransport (subduction's native binary
 * protocol), these tests route subduction frames through automerge-repo's
 * WebSocketClientAdapter / WebSocketServerAdapter via NetworkAdapterTransport.
 *
 * Both the client and server are full Repo instances. The server uses
 * `role: "accept"` and the clients use the default `role: "connect"`.
 *
 * Topology:
 *
 *   client1 ──WebSocketClientAdapter──▸ server Repo (WebSocketServerAdapter)
 *   client2 ──WebSocketClientAdapter──▸       ↕ AdapterConnections (accept)
 *                                          SubductionSource
 */

import { describe, it, expect, afterEach } from "vitest"
import { WebSocketServer } from "ws"
import { WebSocketClientAdapter } from "../../../automerge-repo-network-websocket/src/WebSocketClientAdapter.js"
import { WebSocketServerAdapter } from "../../../automerge-repo-network-websocket/src/WebSocketServerAdapter.js"
import { Repo } from "../../src/Repo.js"
import { generateAutomergeUrl } from "../../src/AutomergeUrl.js"
import { DummyStorageAdapter } from "../../src/helpers/DummyStorageAdapter.js"
import { type PeerId } from "../../src/types.js"
import { pause } from "../../src/helpers/pause.js"
import type { Policy } from "@automerge/automerge-subduction"

// ── Test helpers ──────────────────────────────────────────────────────

/**
 * A server Repo that can be stopped and restarted on the same port.
 * Each restart creates a fresh Repo and WebSocketServer. The underlying
 * storage and signer can optionally be preserved across restarts.
 */
interface TestServerOptions {
  subductionPolicy?: Policy
  periodicSyncInterval?: number
}

class TestServer {
  #port: number
  #wss: WebSocketServer | null = null
  #serverAdapter: WebSocketServerAdapter | null = null
  #storage: DummyStorageAdapter | null = null
  #repo: Repo | null = null
  #opts: TestServerOptions

  get url() {
    return `ws://localhost:${this.#port}`
  }

  get repo() {
    return this.#repo!
  }

  private constructor(port: number, opts: TestServerOptions = {}) {
    this.#port = port
    this.#opts = opts
  }

  static async start(opts?: TestServerOptions): Promise<TestServer> {
    // Grab an ephemeral port
    const tmp = new WebSocketServer({ port: 0 })
    await new Promise<void>(r => tmp.on("listening", r))
    const addr = tmp.address()
    if (typeof addr === "string") throw new Error("unexpected address type")
    const port = addr.port
    await new Promise<void>((r, e) => tmp.close(err => (err ? e(err) : r())))
    const server = new TestServer(port, opts)
    await server.restart()
    return server
  }

  async restart({
    clearStorage = true,
  }: { clearStorage?: boolean } = {}): Promise<void> {
    if (this.#wss) await this.stop()

    if (clearStorage || !this.#storage) {
      this.#storage = new DummyStorageAdapter()
    }

    const serviceName = `localhost:${this.#port}`

    this.#wss = new WebSocketServer({ port: this.#port })
    await new Promise<void>(r => this.#wss!.on("listening", r))

    this.#serverAdapter = new WebSocketServerAdapter(this.#wss!)

    this.#repo = new Repo({
      peerId: `server-${this.#port}` as PeerId,
      storage: this.#storage,
      network: [],
      subductionAdapters: [
        { adapter: this.#serverAdapter, serviceName, role: "accept" },
      ],
      sharePolicy: async () => true,
      subductionPolicy: this.#opts.subductionPolicy,
      periodicSyncInterval: this.#opts.periodicSyncInterval,
    })
  }

  async stop(): Promise<void> {
    if (this.#serverAdapter) {
      this.#serverAdapter.disconnect()
      this.#serverAdapter = null
    }
    if (this.#wss) {
      await new Promise<void>((r, e) =>
        this.#wss!.close(err => (err ? e(err) : r()))
      )
      this.#wss = null
    }
    this.#repo = null
  }

  close = () => this.stop()
}

interface ClientPair {
  repo: Repo
  adapter: WebSocketClientAdapter
}

function createClient(name: string, serverUrl: string): ClientPair {
  const peerId = `${name}-client` as PeerId
  const clientAdapter = new WebSocketClientAdapter(serverUrl)
  const serviceName = new URL(serverUrl).host

  const repo = new Repo({
    peerId,
    storage: new DummyStorageAdapter(),
    network: [],
    subductionAdapters: [{ adapter: clientAdapter, serviceName }],
    sharePolicy: async () => true,
  })

  return { repo, adapter: clientAdapter }
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

describe("Subduction over NetworkAdapterInterface (WebSocket adapter)", () => {
  const cleanups: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) {
      await cleanup()
    }
    cleanups.length = 0
  })

  async function startServer(opts?: TestServerOptions) {
    const server = await TestServer.start(opts)
    cleanups.push(() => server.close())
    return server
  }

  function startClient(name: string, serverUrl: string) {
    const pair = createClient(name, serverUrl)
    cleanups.push(() => pair.adapter.disconnect())
    return pair
  }

  // ── Basic sync ────────────────────────────────────────────────────

  it("document created by one client is found by another", async () => {
    const server = await startServer()

    const alice = startClient("alice", server.url)
    const bob = startClient("bob", server.url)

    const aliceHandle = alice.repo.create<{ title: string }>()
    aliceHandle.change(d => {
      d.title = "Hello from Alice"
    })

    // Create the handle once, then wait for the full data to arrive.
    // Using findWithProgress avoids calling find() repeatedly in a
    // polling loop, which would accumulate handles and subscriptions.
    const progress = bob.repo.findWithProgress<{ title: string }>(
      aliceHandle.url
    )
    await waitForCondition(() => {
      const s = progress.peek()
      return s.state === "ready" && s.handle.doc()?.title === "Hello from Alice"
    }, 5000)

    const result = progress.peek()
    expect(result.state).toBe("ready")
    if (result.state === "ready") {
      expect(result.handle.doc()!.title).toBe("Hello from Alice")
    }
  }, 10_000)

  it("updates flow in both directions", async () => {
    const server = await startServer()

    const alice = startClient("alice", server.url)
    const bob = startClient("bob", server.url)

    const aliceHandle = alice.repo.create<{ alice: string; bob?: string }>()
    aliceHandle.change(d => {
      d.alice = "Alice was here"
    })

    await pause(500)

    const bobHandle = await bob.repo.find<{ alice: string; bob?: string }>(
      aliceHandle.url
    )
    await bobHandle.whenReady()
    expect(bobHandle.doc()!.alice).toBe("Alice was here")

    bobHandle.change(d => {
      d.bob = "Bob was here"
    })

    await waitForCondition(
      () => aliceHandle.doc()!.bob === "Bob was here",
      5000
    )
  }, 10_000)

  // ── Document lifecycle ────────────────────────────────────────────

  it("finding a nonexistent document reports unavailable promptly", async () => {
    const server = await startServer()
    const alice = startClient("alice", server.url)

    // Wait for the connection to be established so we're not just
    // racing against connection setup.
    await pause(500)

    const bogusUrl = generateAutomergeUrl()
    const progress = alice.repo.findWithProgress(bogusUrl)

    await waitForCondition(() => progress.peek().state === "unavailable", 3000)
  }, 10_000)

  // ── Concurrent edits ──────────────────────────────────────────────

  it("simultaneous edits from both clients merge correctly", async () => {
    const server = await startServer()

    const alice = startClient("alice", server.url)
    const bob = startClient("bob", server.url)

    const aliceHandle = alice.repo.create<{
      alice?: string
      bob?: string
    }>()
    aliceHandle.change(() => {
      // initial empty state
    })

    await pause(500)

    const bobHandle = await bob.repo.find<{
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

    await waitForCondition(
      () =>
        aliceHandle.doc()!.bob === "bob-edit" &&
        bobHandle.doc()!.alice === "alice-edit",
      5000
    )

    expect(aliceHandle.doc()!.alice).toBe("alice-edit")
    expect(aliceHandle.doc()!.bob).toBe("bob-edit")
    expect(bobHandle.doc()!.alice).toBe("alice-edit")
    expect(bobHandle.doc()!.bob).toBe("bob-edit")
  }, 10_000)

  it("rapid sequential edits all arrive", async () => {
    const server = await startServer()

    const alice = startClient("alice", server.url)
    const bob = startClient("bob", server.url)

    const aliceHandle = alice.repo.create<{ items: string[] }>()
    aliceHandle.change(d => {
      d.items = []
    })

    await pause(500)

    const bobHandle = await bob.repo.find<{ items: string[] }>(aliceHandle.url)
    await bobHandle.whenReady()

    for (let i = 0; i < 20; i++) {
      aliceHandle.change(d => {
        d.items.push(`item-${i}`)
      })
    }

    await waitForCondition(() => bobHandle.doc()!.items.length === 20, 5000)

    expect(bobHandle.doc()!.items).toHaveLength(20)
    expect(bobHandle.doc()!.items[0]).toBe("item-0")
    expect(bobHandle.doc()!.items[19]).toBe("item-19")
  }, 10_000)

  // ── Connection disruption ─────────────────────────────────────────

  it("server goes down and comes back — sync resumes", async () => {
    const server = await startServer()

    const alice = startClient("alice", server.url)
    const bob = startClient("bob", server.url)

    const aliceHandle = alice.repo.create<{
      before?: string
      after?: string
    }>()
    aliceHandle.change(d => {
      d.before = "before outage"
    })

    await pause(500)

    const bobHandle = await bob.repo.find<{
      before?: string
      after?: string
    }>(aliceHandle.url)
    await bobHandle.whenReady()
    expect(bobHandle.doc()!.before).toBe("before outage")

    // Kill the server and wait for clients to notice
    await server.stop()
    await pause(500)

    // Restart on the same port, keeping storage
    await server.restart({ clearStorage: false })

    // Make the edit AFTER the server is back — this can only reach Bob
    // if the clients successfully reconnect and re-sync via subduction.
    aliceHandle.change(d => {
      d.after = "after outage"
    })

    await waitForCondition(
      () => bobHandle.doc()!.after === "after outage",
      10_000
    )
  }, 20_000)

  // ── Multiple documents ────────────────────────────────────────────

  it("multiple documents sync concurrently", async () => {
    const server = await startServer()

    const alice = startClient("alice", server.url)
    const bob = startClient("bob", server.url)

    const docA = alice.repo.create<{ from: string }>()
    docA.change(d => {
      d.from = "alice"
    })

    const docB = bob.repo.create<{ from: string }>()
    docB.change(d => {
      d.from = "bob"
    })

    await pause(500)

    const bobDocA = await bob.repo.find<{ from: string }>(docA.url)
    await bobDocA.whenReady()
    expect(bobDocA.doc()!.from).toBe("alice")

    const aliceDocB = await alice.repo.find<{ from: string }>(docB.url)
    await aliceDocB.whenReady()
    expect(aliceDocB.doc()!.from).toBe("bob")
  }, 10_000)

  // ── Policy verdict change from deny to allow ──────────────────────────────────────

  it("client gets doc after server policy changes from deny to allow", async () => {
    // Mutable policy: deny fetch for everyone initially, then allow
    let allowFetch = false
    const policy: Policy = {
      async authorizeConnect() {},
      async authorizeFetch(_peerId, _sedimentreeId) {
        if (!allowFetch) throw new Error("fetch denied")
      },
      async authorizePut() {},
      async filterAuthorizedFetch(_peerId, ids) {
        return allowFetch ? ids : []
      },
    }

    const server = await startServer({
      subductionPolicy: policy,
      // Short periodic sync so the server pushes to Bob quickly
      // after the policy changes.
      periodicSyncInterval: 500,
    })

    const alice = startClient("alice", server.url)
    const bob = startClient("bob", server.url)
    await pause(500)

    // Alice pushes a doc (put is allowed).
    const aliceHandle = alice.repo.create<{ value: string }>()
    aliceHandle.change(d => {
      d.value = "access granted"
    })

    // Let Alice's push reach the server's WASM storage
    await pause(1000)

    // Bob requests the doc.
    const progress = bob.repo.findWithProgress<{ value: string }>(
      aliceHandle.url
    )
    await pause(1000)
    expect(progress.peek().state).not.toBe("ready")

    // Policy changes: Bob is now allowed.
    allowFetch = true

    // Tell the client the share config changed.
    bob.repo.shareConfigChanged()

    await waitForCondition(() => {
      const s = progress.peek()
      return s.state === "ready" && s.handle.doc()?.value === "access granted"
    }, 5000)

    expect(progress.peek().state).toBe("ready")
  }, 10_000)
})
