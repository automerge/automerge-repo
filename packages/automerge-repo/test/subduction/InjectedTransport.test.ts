/**
 * Tests for `subductionTransports`, the hook that lets a caller hand
 * `Repo` a pre-built subduction transport instead of a URL string.
 *
 * The transport's lifetime is owned by the caller. This exercises a
 * pattern where one upstream connection is shared between subduction
 * and another protocol layer (e.g. a frame demuxer). Here we use a
 * raw WebSocket via `WebSocketTransport` to keep the test self-contained.
 */

import { describe, it, expect, afterEach } from "vitest"
import { once } from "events"
import { WebSocketServer } from "ws"
import WebSocket from "isomorphic-ws"

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
  serviceName: string
  subduction: Subduction
  wss: WebSocketServer
  close(): Promise<void>
}

async function startSubductionServer(listenPort = 0): Promise<TestServer> {
  const signer = new MemorySigner()
  const storage = new MemoryStorage()
  const subduction = await Subduction.hydrate(signer, storage)

  const wss = new WebSocketServer({ port: listenPort })
  await once(wss, "listening")
  const address = wss.address()
  if (typeof address === "string") throw new Error("unexpected address type")
  const port = address.port
  const url = `ws://localhost:${port}`
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
    serviceName,
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

/**
 * Build a Repo where the subduction transport is opened by the caller and
 * passed in via `subductionTransports`. This is the path a multiplexer
 * (e.g. a FrameDemuxer) would take.
 */
async function createRepoWithInjectedTransport(
  peerId: string,
  serverUrl: string,
  serviceName: string
): Promise<{ repo: Repo; transport: WebSocketTransport }> {
  const transport = await WebSocketTransport.connect(serverUrl)
  const repo = new Repo({
    peerId: peerId as PeerId,
    storage: new DummyStorageAdapter(),
    subductionTransports: [{ transport, serviceName }],
  })
  return { repo, transport }
}

describe("Subduction injected transport", () => {
  const cleanups: Array<() => Promise<void>> = []

  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) {
      await cleanup()
    }
    cleanups.length = 0
  })

  it("syncs a document from client to server through an injected transport", async () => {
    const server = await startSubductionServer()
    cleanups.push(() => server.close())

    const { repo } = await createRepoWithInjectedTransport(
      "client-injected-1",
      server.url,
      server.serviceName
    )

    const handle = repo.create<{ text: string }>()
    handle.change(d => {
      d.text = "hello via injected transport"
    })

    const sid = toSedimentreeId(handle.documentId)
    await waitForCondition(async () => {
      const blobs = await server.subduction.getBlobs(sid)
      return blobs !== undefined && blobs.length > 0
    }, 5000)

    const blobs = await server.subduction.getBlobs(sid)
    expect(blobs.length).toBeGreaterThan(0)
  })

  it("two clients sync through a server using injected transports", async () => {
    const server = await startSubductionServer()
    cleanups.push(() => server.close())

    const { repo: client1 } = await createRepoWithInjectedTransport(
      "client-injected-a",
      server.url,
      server.serviceName
    )
    const { repo: client2 } = await createRepoWithInjectedTransport(
      "client-injected-b",
      server.url,
      server.serviceName
    )

    const handle1 = client1.create<{ value: number }>()
    handle1.change(d => {
      d.value = 7
    })
    await pause(500)

    const handle2 = await client2.find<{ value: number }>(handle1.url)
    await handle2.whenReady()
    expect(handle2.doc()!.value).toBe(7)
  }, 10_000)

  it("does not open its own websocket. Passing only subductionTransports works without subductionWebsocketEndpoints", async () => {
    const server = await startSubductionServer()
    cleanups.push(() => server.close())

    let directWsConnections = 0
    server.wss.on("connection", () => {
      directWsConnections++
    })

    // Open a single WS via WebSocketTransport (caller-owned).
    const transport = await WebSocketTransport.connect(server.url)
    const repo = new Repo({
      peerId: "client-only-injected" as PeerId,
      storage: new DummyStorageAdapter(),
      subductionTransports: [{ transport, serviceName: server.serviceName }],
    })

    const handle = repo.create<{ x: number }>()
    handle.change(d => {
      d.x = 1
    })

    const sid = toSedimentreeId(handle.documentId)
    await waitForCondition(async () => {
      const blobs = await server.subduction.getBlobs(sid)
      return blobs !== undefined && blobs.length > 0
    }, 5000)

    // The caller opened exactly one WebSocket. Repo did not open another.
    expect(directWsConnections).toBe(1)
  })
})
