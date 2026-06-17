import { describe, it, expect, afterEach } from "vitest"
import { once } from "events"
import { WebSocketServer } from "ws"

import type { Transport } from "@automerge/automerge-subduction/slim"
import {
  Subduction,
  MemorySigner,
  MemoryStorage,
} from "@automerge/automerge-subduction"
import { Repo } from "../../src/Repo.js"
import { DummyStorageAdapter } from "../../src/helpers/DummyStorageAdapter.js"
import { type PeerId } from "../../src/types.js"
import { toSedimentreeId } from "../../src/subduction/helpers.js"
import { WebSocketTransport } from "../../src/subduction/websocket-transport.js"
import { pause } from "../../src/helpers/pause.js"

/** Poll a condition until it returns true, or throw after timeout. */
async function waitForCondition(
  fn: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 200
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await pause(intervalMs)
  }
  throw new Error(`waitForCondition timed out after ${timeoutMs}ms`)
}

interface TestServer {
  port: number
  url: string
  subduction: Subduction
  wss: WebSocketServer
  close(): Promise<void>
}

/**
 * Start a subduction-capable WebSocket server.
 *
 * Each incoming WebSocket connection is wrapped as a {@link WebSocketTransport}
 * and handed to `subduction.acceptTransport()`, which runs the responder side
 * of the cryptographic handshake and adds the authenticated connection.
 */

async function startSubductionServer(listenPort = 0): Promise<TestServer> {
  const signer = new MemorySigner()
  const storage = new MemoryStorage()
  const subduction = new Subduction({ signer, storage })

  const wss = new WebSocketServer({ port: listenPort })
  await once(wss, "listening")

  const address = wss.address()
  if (typeof address === "string") throw new Error("unexpected address type")
  const port = address.port
  const url = `ws://localhost:${port}`

  // The service_name must match what the client uses.
  // SubductionSource uses `new URL(url).host` as the service name.
  const serviceName = `localhost:${port}`

  wss.on("connection", ws => {
    const transport = new WebSocketTransport(ws as any)
    subduction
      .acceptTransport(transport, serviceName)
      .catch(e => console.error("acceptTransport failed:", e))
  })

  return {
    port,
    url,
    subduction,
    wss,
    async close() {
      await subduction.disconnectAll()
      await new Promise<void>((resolve, reject) =>
        wss.close(err => (err ? reject(err) : resolve()))
      )
    },
  }
}

function createClientRepo(peerId: string, serverUrl: string): Repo {
  return new Repo({
    peerId: peerId as PeerId,
    storage: new DummyStorageAdapter(),
    subductionWebsocketEndpoints: [serverUrl],
  })
}

/**
 * Wraps a {@link WebSocketTransport} so the server can go silent on
 * demand. Once `blackhole` is set, the socket stays OPEN (so the peer
 * is not dropped from the client's peer set) but the server neither
 * reads nor answers: `recvBytes` never resolves and `sendBytes` is
 * discarded. A client sync round against this peer therefore gets no
 * response and can only end by hitting its own deadline — which is
 * exactly the condition `shutdown()`'s bounded final round must
 * survive.
 */
class ControllableTransport implements Transport {
  blackhole = false
  #inner: WebSocketTransport

  constructor(inner: WebSocketTransport) {
    this.#inner = inner
  }

  sendBytes(bytes: Uint8Array): Promise<void> {
    if (this.blackhole) return Promise.resolve()
    return this.#inner.sendBytes(bytes)
  }

  recvBytes(): Promise<Uint8Array> {
    if (this.blackhole) return new Promise<Uint8Array>(() => {})
    return this.#inner.recvBytes()
  }

  disconnect(): Promise<void> {
    return this.#inner.disconnect()
  }

  closed(): Promise<void> {
    return this.#inner.closed()
  }

  onDisconnect(callback: () => void): void {
    this.#inner.onDisconnect(callback)
  }
}

interface BlackholeServer {
  url: string
  subduction: Subduction
  blackholeAll(): void
  close(): Promise<void>
}

/**
 * Like {@link startSubductionServer}, but exposes a `blackholeAll()`
 * switch that makes every accepted transport go silent (see
 * {@link ControllableTransport}). The cryptographic handshake completes
 * normally before blackholing, so the peer stays connected and counted.
 */
async function startBlackholeServer(): Promise<BlackholeServer> {
  const subduction = new Subduction({
    signer: new MemorySigner(),
    storage: new MemoryStorage(),
  })

  const wss = new WebSocketServer({ port: 0 })
  await once(wss, "listening")
  const address = wss.address()
  if (typeof address === "string") throw new Error("unexpected address type")
  const { port } = address
  const url = `ws://localhost:${port}`
  const serviceName = `localhost:${port}`

  const transports: ControllableTransport[] = []
  wss.on("connection", ws => {
    const transport = new ControllableTransport(
      new WebSocketTransport(ws as any)
    )
    transports.push(transport)
    subduction
      .acceptTransport(transport, serviceName)
      .catch(e => console.error("acceptTransport failed:", e))
  })

  return {
    url,
    subduction,
    blackholeAll() {
      for (const t of transports) t.blackhole = true
    },
    async close() {
      await subduction.disconnectAll()
      await new Promise<void>((resolve, reject) =>
        wss.close(err => (err ? reject(err) : resolve()))
      )
    },
  }
}

describe("Subduction WebSocket sync", () => {
  const cleanups: Array<() => Promise<void>> = []

  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) {
      await cleanup()
    }
    cleanups.length = 0
  })

  it("syncs a document from client to server", async () => {
    const server = await startSubductionServer()
    cleanups.push(() => server.close())

    const repo = createClientRepo("client-1", server.url)

    const handle = repo.create<{ text: string }>()
    handle.change(d => {
      d.text = "hello from client"
    })

    const sid = toSedimentreeId(handle.documentId)
    await waitForCondition(async () => {
      const blobs = await server.subduction.getBlobs(sid)
      return blobs !== undefined && blobs.length > 0
    }, 5000)

    const blobs = await server.subduction.getBlobs(sid)
    expect(blobs.length).toBeGreaterThan(0)
  })

  it("syncs a document from server to client", async () => {
    const server = await startSubductionServer()
    cleanups.push(() => server.close())

    // Client 1 creates a doc and pushes it to the server
    const client1 = createClientRepo("client-1", server.url)

    const handle1 = client1.create<{ count: number }>()
    handle1.change(d => {
      d.count = 42
    })

    await pause(500)

    // Client 2 connects and fetches the same doc
    const client2 = createClientRepo("client-2", server.url)

    const handle2 = await client2.find<{ count: number }>(handle1.url)
    await handle2.whenReady()

    const doc = handle2.doc()!
    console.log(
      `[test] after whenReady: heads=${handle2.heads().length}, ` +
        `keys=${Object.keys(doc)}, count=${doc.count}`
    )

    expect(doc.count).toBe(42)
  }, 10_000)

  it("two clients sync through a server", async () => {
    const server = await startSubductionServer()
    cleanups.push(() => server.close())

    const client1 = createClientRepo("client-1", server.url)
    const client2 = createClientRepo("client-2", server.url)

    // Client 1 creates a doc
    const handle1 = client1.create<{ items: string[] }>()
    handle1.change(d => {
      d.items = ["first"]
    })

    await pause(500)

    // Client 2 finds it
    const handle2 = await client2.find<{ items: string[] }>(handle1.url)
    await handle2.whenReady()

    expect(handle2.doc()!.items).toEqual(["first"])

    // Client 2 makes a change
    handle2.change(d => {
      d.items.push("second")
    })

    await pause(500)

    // Client 1 should see the change (via server re-sync/subscription)
    // Force a re-sync by checking the handle
    expect(handle1.doc()!.items).toContain("second")
  }, 10_000)

  it("client finds a document after subduction reconnects", async () => {
    // Start the server AFTER creating the repo, so the connection
    // manager's first attempt fails and it has to reconnect.

    // Grab a port, then close the server so the client fails initially
    const tmpWss = new WebSocketServer({ port: 0 })
    await new Promise<void>(resolve => tmpWss.on("listening", resolve))
    const address = tmpWss.address()
    if (typeof address === "string") throw new Error("unexpected")
    const port = address.port
    const url = `ws://localhost:${port}`
    await new Promise<void>((resolve, reject) =>
      tmpWss.close(err => (err ? reject(err) : resolve()))
    )

    // Create the client repo pointing at the (closed) server
    const client1 = createClientRepo("client-1", url)

    // Create a document while disconnected
    const handle1 = client1.create<{ value: string }>()
    handle1.change(d => {
      d.value = "created while disconnected"
    })

    // Now start the real server on the same port
    const signer = new MemorySigner()
    const memStorage = new MemoryStorage()
    const subduction = new Subduction({ signer, storage: memStorage })
    const serviceName = `localhost:${port}`

    const serverWss = new WebSocketServer({ port })
    await new Promise<void>(resolve => serverWss.on("listening", resolve))
    cleanups.push(async () => {
      await subduction.disconnectAll()
      await new Promise<void>((resolve, reject) =>
        serverWss.close(err => (err ? reject(err) : resolve()))
      )
    })

    serverWss.on("connection", ws => {
      const transport = new WebSocketTransport(ws as any)
      subduction
        .acceptTransport(transport, serviceName)
        .catch(e => console.error("acceptTransport failed:", e))
    })

    // Wait for the client to reconnect and sync the document to the server
    const sid = toSedimentreeId(handle1.documentId)
    await waitForCondition(async () => {
      const blobs = await subduction.getBlobs(sid)
      return blobs.length > 0
    }, 10_000)
  }, 10_000)

  it("find issued while connecting resolves after connection", async () => {
    const server = await startSubductionServer()
    cleanups.push(() => server.close())

    // Client 1 creates a doc and pushes it
    const client1 = createClientRepo("client-1", server.url)
    const handle1 = client1.create<{ value: number }>()
    handle1.change(d => {
      d.value = 99
    })
    await pause(500)

    // Client 2: issue find() immediately — the connection manager is
    // still connecting at this point, so syncWithAllPeers will find 0
    // peers initially. The query should stay pending until the
    // connection is established and #onPeerConnected re-syncs.
    const client2 = createClientRepo("client-2", server.url)
    const handle2 = await client2.find<{ value: number }>(handle1.url)
    await handle2.whenReady()
    expect(handle2.doc()!.value).toBe(99)
  }, 10_000)

  it("does not spin when saving locally with no connected peers", async () => {
    // Start a real server to grab a known port, then shut it down so
    // the client gets ECONNREFUSED. This reduces the TOCTOU race of
    // binding an ephemeral port, releasing it, and hoping nobody else
    // claims it before our server restarts.
    const tempServer = await startSubductionServer()
    const freePort = Number(new URL(tempServer.url).port)
    await tempServer.close()

    const serverUrl = `ws://localhost:${freePort}`
    const client = createClientRepo("client-1", serverUrl)

    // Create a doc and make changes while disconnected
    const handle = client.create<{ value: number }>()
    handle.change(d => {
      d.value = 42
    })

    // Wait long enough that an infinite loop would have spun hundreds of
    // times. If the no-peers guard is missing, this would peg the CPU.
    await pause(500)

    // Now start the server on the same port
    const server = await startSubductionServer(freePort)
    cleanups.push(() => server.close())

    // Wait for the reconnect backoff (1s base, doubles each retry) + sync
    await waitForCondition(async () => {
      const sid = toSedimentreeId(handle.documentId)
      const blobs = await server.subduction.getBlobs(sid)
      return blobs !== undefined && blobs.length > 0
    }, 8000)

    // Verify the data reached the server
    const sid = toSedimentreeId(handle.documentId)
    const blobs = await server.subduction.getBlobs(sid)
    expect(blobs.length).toBeGreaterThan(0)
  }, 10_000)

  it("syncs saves made while disconnected once a peer connects", async () => {
    // Verify that the no-peers guard on #save doesn't permanently
    // block sync. Saves made while disconnected must be pushed once
    // a connection is established (via #setConnectionState resetting
    // lastSyncResult).
    const server = await startSubductionServer()
    const serverPort = Number(new URL(server.url).port)

    const client = createClientRepo("client-1", server.url)

    // Wait for the connection to establish
    await pause(500)

    // Stop the server — client is now disconnected
    await server.close()
    await pause(200)

    // Make several changes while disconnected. Each #save will see
    // lastSyncResult === "no-peers" and skip the sync trigger.
    const handle = client.create<{ items: string[] }>()
    handle.change(d => {
      d.items = ["first"]
    })
    handle.change(d => {
      d.items.push("second")
    })
    handle.change(d => {
      d.items.push("third")
    })

    await pause(500)

    // Restart the server on the same port — client will reconnect
    // and #setConnectionState("running") should reset lastSyncResult,
    // triggering a sync that pushes all accumulated changes.
    const newServer = await startSubductionServer(serverPort)
    cleanups.push(() => newServer.close())

    // Verify ALL changes made while disconnected arrive at the server
    const sid = toSedimentreeId(handle.documentId)
    await waitForCondition(async () => {
      const blobs = await newServer.subduction.getBlobs(sid)
      return blobs !== undefined && blobs.length > 0
    }, 8000)

    // Verify by loading the doc on a second client
    const client2 = createClientRepo("client-2", newServer.url)
    const handle2 = await client2.find<{ items: string[] }>(handle.url)
    await handle2.whenReady()

    expect(handle2.doc()!.items).toEqual(["first", "second", "third"])
  }, 15_000)

  // Regression: receivers dedup on `(senderId, sessionId, count)` in
  // `DocSynchronizer.#receiveEphemeralMessage`. The Subduction bridge in
  // `Repo.ts` used to hard-code `count: 0`, so every message after the
  // first from a given sender looked like a duplicate and was silently
  // dropped on the receiver side. This guards against re-introducing
  // that — without the per-Repo monotonic counter the second and third
  // broadcasts never make it past dedup.
  it("delivers multiple successive ephemeral broadcasts from the same sender", async () => {
    const server = await startSubductionServer()
    cleanups.push(() => server.close())

    // Mirror the setup used by "two clients sync through a server":
    // create the doc on client1, give it time to reach the server,
    // then have client2 connect and find it.
    const client1 = createClientRepo("client-1", server.url)
    const handle1 = client1.create<{ value: string }>()
    handle1.change(d => {
      d.value = "shared"
    })
    await pause(500)

    const client2 = createClientRepo("client-2", server.url)
    const handle2 = await client2.find<{ value: string }>(handle1.url)
    await handle2.whenReady()

    // Settle: peers must be exchanged and ephemeral subscriptions
    // registered on the server before broadcasts will be relayed.
    await pause(500)

    const received: unknown[] = []
    handle2.on("ephemeral-message", ({ message }) => {
      received.push(message)
    })

    handle1.broadcast({ seq: 1 })
    handle1.broadcast({ seq: 2 })
    handle1.broadcast({ seq: 3 })

    await waitForCondition(() => received.length >= 3, 3000)

    expect(received).toEqual([{ seq: 1 }, { seq: 2 }, { seq: 3 }])
  }, 10_000)

  // Saves are store-only; propagation rides the #doSync arm, which
  // shutdown disables (#shuttingDown makes #scheduleRecompute a no-op).
  // So the only thing that can publish a change made in shutdown's shadow
  // is shutdown()'s final quiesce round — without it, a short-lived CLI
  // process writes durably but never publishes.
  it("a change made immediately before shutdown still reaches a connected peer", async () => {
    const server = await startSubductionServer()
    cleanups.push(() => server.close())

    const client1 = createClientRepo("client-1", server.url)
    // Warm up: confirm the client is actually connected (a warm-up doc
    // reaches the server) before the timing-sensitive part, so the
    // quiesce round is guaranteed a peer. A fixed pause would be racy
    // under parallel load.
    const warmup = client1.create<{ x: number }>({ x: 1 })
    await waitForCondition(async () => {
      const blobs = await server.subduction.getBlobs(
        toSedimentreeId(warmup.documentId)
      )
      return blobs !== undefined && blobs.length > 0
    }, 8000)

    // Mutate, then shut down with NO intervening await: the 100ms save
    // throttle never fires on its own, and shutdown suppresses the
    // background sync — so only the final quiesce round can publish.
    const handle1 = client1.create<{ value: number }>({ value: 0 })
    handle1.change(d => {
      d.value = 42
    })
    const url = handle1.url
    await client1.shutdown()

    // A fresh client sees the change only if it reached the server
    // during shutdown rather than being stranded in client1's store.
    const client2 = createClientRepo("client-2", server.url)
    cleanups.push(async () => {
      await client2.shutdown()
    })
    const handle2 = await client2.find<{ value: number }>(url)
    await handle2.whenReady()

    expect(handle2.doc()!.value).toBe(42)
  }, 20_000)

  // The final quiesce round pushes to peers that may be gone or wedged.
  // It is capped at SHUTDOWN_SYNC_TIMEOUT_MS (5s) precisely so an
  // unresponsive peer can't pin teardown for the full (default 60s)
  // sync deadline. The doc is synced BEFORE the peer goes dark, so no
  // in-flight sync lingers — this isolates the final round's own cap.
  it("shutdown stays bounded when a connected peer stops responding", async () => {
    const server = await startBlackholeServer()
    cleanups.push(() => server.close())

    const client = createClientRepo("client-1", server.url)
    let shutDown = false
    const shutdownOnce = async () => {
      if (shutDown) return
      shutDown = true
      await client.shutdown()
    }
    cleanups.push(shutdownOnce)

    // Create + sync a doc while the peer is healthy, so its sync round
    // completes (no in-flight #doSync at shutdown time).
    const handle = client.create<{ value: number }>({ value: 0 })
    const sid = toSedimentreeId(handle.documentId)
    await waitForCondition(async () => {
      const blobs = await server.subduction.getBlobs(sid)
      return blobs !== undefined && blobs.length > 0
    }, 8000)

    // Peer goes dark: still connected (handshake done), but every
    // further sync request gets no response.
    server.blackholeAll()

    // A change with no broadcast path left but the final quiesce round,
    // which will hit the silent peer and have to time out.
    handle.change(d => {
      d.value = 1
    })

    const t0 = performance.now()
    await shutdownOnce()
    const elapsed = performance.now() - t0

    // ~5s with the cap; the 60s default would blow past this (and the
    // 40s test deadline) if the final round were left uncapped.
    expect(elapsed).toBeLessThan(20_000)
  }, 40_000)
})
