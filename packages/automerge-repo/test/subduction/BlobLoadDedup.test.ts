/**
 * Regression: first-open sync must not call getBlobs twice.
 *
 * `#doSync` used to load blobs reactively after every sync that received
 * data, and `#loadBlobsAndTransition` would load again when transitioning
 * out of "initializing". That doubled storage reads on the critical
 * first-load path.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { once } from "events"
import { WebSocketServer } from "ws"

import {
  Subduction,
  MemorySigner,
  MemoryStorage,
} from "@automerge/automerge-subduction"
import { Repo } from "../../src/Repo.js"
import { DummyStorageAdapter } from "../../src/helpers/DummyStorageAdapter.js"
import { pause } from "../../src/helpers/pause.js"
import { initSubduction } from "../../src/initSubduction.js"
import { toSedimentreeId } from "../../src/subduction/helpers.js"
import { WebSocketTransport } from "../../src/subduction/websocket-transport.js"
import type { PeerId } from "../../src/types.js"

beforeAll(async () => {
  await initSubduction()
})

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

async function startSubductionServer(listenPort = 0): Promise<{
  url: string
  subduction: Subduction
  close(): Promise<void>
}> {
  const signer = new MemorySigner()
  const storage = new MemoryStorage()
  const subduction = new Subduction(signer, storage)

  const wss = new WebSocketServer({ port: listenPort })
  await once(wss, "listening")

  const address = wss.address()
  if (typeof address === "string") throw new Error("unexpected address type")
  const url = `ws://localhost:${address.port}`
  const serviceName = `localhost:${address.port}`

  wss.on("connection", ws => {
    const transport = new WebSocketTransport(ws as any)
    subduction
      .acceptTransport(transport, serviceName)
      .catch(e => console.error("acceptTransport failed:", e))
  })

  return {
    url,
    subduction,
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

describe("SubductionSource blob load deduplication", () => {
  const cleanups: Array<() => Promise<void>> = []

  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) {
      await cleanup()
    }
    cleanups.length = 0
  })

  it("calls getBlobs once when opening a document for the first time", async () => {
    const server = await startSubductionServer()
    cleanups.push(() => server.close())

    const writer = createClientRepo("writer", server.url)
    const handle = writer.create<{ text: string }>()
    handle.change(d => {
      d.text = "hello"
    })

    const sid = toSedimentreeId(handle.documentId)
    await waitForCondition(async () => {
      const blobs = await server.subduction.getBlobs(sid)
      return blobs !== undefined && blobs.length > 0
    }, 5000)

    const reader = createClientRepo("reader", server.url)
    const subduction = await reader.subduction
    const originalGetBlobs = subduction.getBlobs.bind(subduction)
    let getBlobsCalls = 0
    subduction.getBlobs = async id => {
      getBlobsCalls++
      return originalGetBlobs(id)
    }

    const fetched = await reader.find<{ text: string }>(handle.url)

    expect(fetched.doc()?.text).toBe("hello")
    expect(getBlobsCalls).toBe(1)
  })

  it("still receives live updates after the document is running", async () => {
    const server = await startSubductionServer()
    cleanups.push(() => server.close())

    const writer = createClientRepo("writer", server.url)
    const handle = writer.create<{ count: number }>()
    handle.change(d => {
      d.count = 1
    })

    const sid = toSedimentreeId(handle.documentId)
    await waitForCondition(async () => {
      const blobs = await server.subduction.getBlobs(sid)
      return blobs !== undefined && blobs.length > 0
    }, 5000)

    const reader = createClientRepo("reader", server.url)
    const fetched = await reader.find<{ count: number }>(handle.url)
    expect(fetched.doc()?.count).toBe(1)

    handle.change(d => {
      d.count = 2
    })

    await waitForCondition(async () => fetched.doc()?.count === 2, 5000)
  })
})
