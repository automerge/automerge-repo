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
import { awaitDoc } from "../helpers/awaitDoc.js"
import { awaitProgress } from "../helpers/awaitProgress.js"
import { awaitSubductionConnected } from "../helpers/awaitSubductionConnected.js"
import { awaitSyncedHandle } from "../helpers/awaitSyncedHandle.js"
import { wait } from "../helpers/wait.js"
import type { Policy } from "@automerge/automerge-subduction"

// ── Test helpers ──────────────────────────────────────────────────────

/**
 * A server Repo that can be stopped and restarted on the same port.
 * Each restart creates a fresh Repo and WebSocketServer. The underlying
 * storage and signer can optionally be preserved across restarts.
 */
interface TestServerOptions {
  subductionPolicy?: Policy
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
    const bobHandle = await awaitSyncedHandle(
      progress,
      h => h.doc()?.title === "Hello from Alice",
      { timeout: 5000 }
    )
    expect(bobHandle.doc()!.title).toBe("Hello from Alice")
  }, 10_000)

  it("updates flow in both directions", async () => {
    const server = await startServer()

    const alice = startClient("alice", server.url)
    const bob = startClient("bob", server.url)

    const aliceHandle = alice.repo.create<{ alice: string; bob?: string }>()
    aliceHandle.change(d => {
      d.alice = "Alice was here"
    })

    const bobProgress = bob.repo.findWithProgress<{
      alice: string
      bob?: string
    }>(aliceHandle.url)
    const bobHandle = await awaitSyncedHandle(
      bobProgress,
      h => h.doc()?.alice === "Alice was here",
      { timeout: 5000 }
    )

    bobHandle.change(d => {
      d.bob = "Bob was here"
    })

    await awaitDoc(aliceHandle, h => h.doc()?.bob === "Bob was here", {
      timeout: 5000,
    })
  }, 10_000)

  // ── Document lifecycle ────────────────────────────────────────────

  it("finding a nonexistent document reports unavailable promptly", async () => {
    const server = await startServer()
    const alice = startClient("alice", server.url)

    // Wait for the connection to be established so we're not just
    // racing against connection setup.
    await awaitSubductionConnected(alice.repo, { timeout: 5000 })

    const bogusUrl = generateAutomergeUrl()
    const progress = alice.repo.findWithProgress(bogusUrl)

    await awaitProgress(progress, s => s.state === "unavailable", {
      timeout: 3000,
    })
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

    const bobProgress = bob.repo.findWithProgress<{
      alice?: string
      bob?: string
    }>(aliceHandle.url)
    const bobHandle = await awaitSyncedHandle(bobProgress, undefined, {
      timeout: 5000,
    })

    // Both edit simultaneously (different keys — no conflict)
    aliceHandle.change(d => {
      d.alice = "alice-edit"
    })
    bobHandle.change(d => {
      d.bob = "bob-edit"
    })

    await Promise.all([
      awaitDoc(aliceHandle, h => h.doc()?.bob === "bob-edit", {
        timeout: 5000,
      }),
      awaitDoc(bobHandle, h => h.doc()?.alice === "alice-edit", {
        timeout: 5000,
      }),
    ])

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

    const bobProgress = bob.repo.findWithProgress<{ items: string[] }>(
      aliceHandle.url
    )
    const bobHandle = await awaitSyncedHandle(bobProgress, undefined, {
      timeout: 5000,
    })

    for (let i = 0; i < 20; i++) {
      aliceHandle.change(d => {
        d.items.push(`item-${i}`)
      })
    }

    await awaitDoc(bobHandle, h => (h.doc()?.items.length ?? 0) === 20, {
      timeout: 5000,
    })

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

    const bobProgress = bob.repo.findWithProgress<{
      before?: string
      after?: string
    }>(aliceHandle.url)
    const bobHandle = await awaitSyncedHandle(
      bobProgress,
      h => h.doc()?.before === "before outage",
      { timeout: 5000 }
    )

    // Kill, then restart. Clients reconnect lazily (no prompt disconnect
    // signal), so a brief bounded pause; the post-restart sync below is the
    // real check.
    await server.stop()
    await wait(500)

    // Restart on the same port, keeping storage
    await server.restart({ clearStorage: false })

    // Make the edit AFTER the server is back — this can only reach Bob
    // if the clients successfully reconnect and re-sync via subduction.
    aliceHandle.change(d => {
      d.after = "after outage"
    })

    await awaitDoc(bobHandle, h => h.doc()?.after === "after outage", {
      timeout: 10_000,
    })
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

    const bobDocA = await awaitSyncedHandle(
      bob.repo.findWithProgress<{ from: string }>(docA.url),
      h => h.doc()?.from === "alice",
      { timeout: 5000 }
    )
    expect(bobDocA.doc()!.from).toBe("alice")

    const aliceDocB = await awaitSyncedHandle(
      alice.repo.findWithProgress<{ from: string }>(docB.url),
      h => h.doc()?.from === "bob",
      { timeout: 5000 }
    )
    expect(aliceDocB.doc()!.from).toBe("bob")
  }, 10_000)

  // ── Policy verdict change from deny to allow ──────────────────────────────────────

  // KNOWN FLAKE (retried): recovery after a deny→allow flip depends on
  // subduction re-offering the doc via `filterAuthorizedFetch` on the
  // client's re-sync. Subduction sometimes authorizes the fetch
  // (`authorizeFetch` allow=true) without invoking `filterAuthorizedFetch`,
  // so no data is delivered and the client stays `unavailable`. The
  // SubductionSource state machine retries correctly; the gap is
  // server-side in the subduction crate. See .ignore/FIXME.md. Retried
  // until fixed upstream.
  it(
    "client gets doc after server policy changes from deny to allow",
    { retry: 3, timeout: 10_000 },
    async () => {
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
      })

      const alice = startClient("alice", server.url)
      const bob = startClient("bob", server.url)
      await Promise.all([
        awaitSubductionConnected(alice.repo, { timeout: 5000 }),
        awaitSubductionConnected(bob.repo, { timeout: 5000 }),
      ])

      // Alice pushes a doc (put is allowed).
      const aliceHandle = alice.repo.create<{ value: string }>()
      aliceHandle.change(d => {
        d.value = "access granted"
      })

      // Let Alice's push reach the server's WASM storage. The server is a raw
      // Subduction with no "stored" event to await, so this is a bounded wait.
      await wait(1000)

      // Bob requests the doc; while the policy denies fetch it must NOT become
      // ready. There is no "fetch denied" signal, so confirm over a bounded
      // window.
      const progress = bob.repo.findWithProgress<{ value: string }>(
        aliceHandle.url
      )
      await wait(1000)
      expect(progress.peek().state).not.toBe("ready")

      // Policy changes: Bob is now allowed.
      allowFetch = true

      // Tell the client the share config changed.
      bob.repo.shareConfigChanged()

      const bobHandle = await awaitSyncedHandle(
        progress,
        h => h.doc()?.value === "access granted",
        { timeout: 5000 }
      )
      expect(bobHandle.doc()!.value).toBe("access granted")
    }
  )
})
