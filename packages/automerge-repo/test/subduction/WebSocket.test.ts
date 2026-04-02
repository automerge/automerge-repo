import { describe, it, expect, afterEach } from "vitest"
import { WebSocketServer } from "ws"
import * as net from "net"
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
  const subduction = await Subduction.hydrate(signer, storage)

  const wss = new WebSocketServer({ port: listenPort })
  await new Promise<void>((resolve, reject) => {
    wss.once("listening", resolve)
    wss.once("error", reject)
  })

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
    const subduction = await Subduction.hydrate(signer, memStorage)
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
    // Grab a free port, then release it so the repo gets ECONNREFUSED.
    // The TOCTOU window is small and acceptable for a test environment.
    const freePort = await new Promise<number>((resolve, reject) => {
      const srv = net.createServer()
      srv.once("error", reject)
      srv.listen(0, () => {
        const addr = srv.address() as net.AddressInfo
        srv.close(() => resolve(addr.port))
      })
    })

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
})
