/**
 * Repro/regression for live incremental sync through the worker-based
 * WebSocket endpoint: a client whose socket lives in a worker_threads
 * worker must receive pushed updates WITHOUT reconnecting or re-finding
 * (reported symptom: only batch updates on page load in the dogfood app).
 *
 * Mirrors WebSocket.test.ts "two clients sync through a server", with the
 * receiving client on a WorkerWebSocketEndpoint. Gated on dist/ (the
 * worker entry must be built).
 */
import { existsSync } from "node:fs"
import path from "node:path"
import { once } from "node:events"
import {
  MessageChannel as NodeMessageChannel,
  Worker as NodeWorker,
} from "node:worker_threads"
import { afterEach, describe, expect, it } from "vitest"
import { WebSocketServer } from "ws"

import {
  MemorySigner,
  MemoryStorage,
  Subduction,
} from "@automerge/automerge-subduction"
import { Repo } from "../../src/Repo.js"
import { DummyStorageAdapter } from "../../src/helpers/DummyStorageAdapter.js"
import { type PeerId } from "../../src/types.js"
import { WebSocketTransport } from "../../src/subduction/websocket-transport.js"
import { WorkerWebSocketEndpoint } from "../../src/subduction/websocket-endpoint.js"
import type { WorkerPortLike } from "../../src/subduction/worker-websocket/protocol.js"
import { awaitDoc } from "../helpers/awaitDoc.js"
import { awaitSyncedHandle } from "../helpers/awaitSyncedHandle.js"

const DIST_ENTRY_REL = "dist/subduction/worker-websocket/worker-entry-node.js"
const pkgRoot = [
  process.cwd(),
  path.resolve(process.cwd(), "packages/automerge-repo"),
].find(root => existsSync(path.join(root, DIST_ENTRY_REL)))
const distEntry = pkgRoot ? path.join(pkgRoot, DIST_ENTRY_REL) : null

async function startSubductionServer() {
  const signer = new MemorySigner()
  const storage = new MemoryStorage()
  const subduction = new Subduction({ signer, storage })

  const wss = new WebSocketServer({ port: 0 })
  await once(wss, "listening")
  const address = wss.address()
  if (address === null || typeof address === "string")
    throw new Error("unexpected address type")
  const url = `ws://localhost:${address.port}`
  const serviceName = `localhost:${address.port}`

  wss.on("connection", ws => {
    const transport = new WebSocketTransport(ws as never)
    subduction
      .acceptTransport(transport, serviceName)
      .catch(e => console.error("acceptTransport failed:", e))
  })

  return {
    url,
    async close() {
      await subduction.disconnectAll()
      await new Promise<void>((resolve, reject) =>
        wss.close(err => (err ? reject(err) : resolve()))
      )
    },
  }
}

describe.skipIf(distEntry === null)(
  "live incremental sync over WorkerWebSocketEndpoint",
  () => {
    const cleanups: Array<() => Promise<void> | void> = []

    afterEach(async () => {
      for (const cleanup of cleanups.reverse()) await cleanup()
      cleanups.length = 0
    })

    const spawnHostPort = (): WorkerPortLike => {
      if (distEntry === null) throw new Error("unreachable: dist gated")
      const channel = new NodeMessageChannel()
      const worker = new NodeWorker(distEntry, {
        workerData: { port: channel.port2 },
        transferList: [channel.port2],
      })
      worker.unref()
      cleanups.push(() => void worker.terminate())
      return channel.port1 as unknown as WorkerPortLike
    }

    it("pushes a later change to a worker-endpoint client without re-find", async () => {
      const server = await startSubductionServer()
      cleanups.push(() => server.close())

      // Writer: plain in-thread endpoint (known good).
      const writer = new Repo({
        peerId: "writer" as PeerId,
        storage: new DummyStorageAdapter(),
        subductionWebsocketEndpoints: [server.url],
      })
      cleanups.push(() => writer.shutdown())

      // Reader: socket lives in a worker.
      const reader = new Repo({
        peerId: "reader" as PeerId,
        storage: new DummyStorageAdapter(),
        subductionWebsocketEndpoints: [
          new WorkerWebSocketEndpoint(server.url, {
            worker: spawnHostPort(),
          }),
        ],
      })
      cleanups.push(() => reader.shutdown())

      // Writer creates the doc; reader finds it (the "page load" batch).
      const writerHandle = writer.create<{ items: string[] }>()
      writerHandle.change(d => {
        d.items = ["first"]
      })

      const readerHandle = await awaitSyncedHandle(
        reader.findWithProgress<{ items: string[] }>(writerHandle.url),
        h => h.doc()?.items?.[0] === "first",
        { timeout: 8000 }
      )
      expect(readerHandle.doc()!.items).toEqual(["first"])

      // THE repro: a change made AFTER the reader is already synced must
      // arrive live — no reconnect, no re-find, no reload.
      writerHandle.change(d => {
        d.items.push("second")
      })

      await awaitDoc(
        readerHandle,
        h => h.doc()?.items?.includes("second") ?? false,
        { timeout: 5000 }
      )
      expect(readerHandle.doc()!.items).toContain("second")

      // And the reverse direction: reader writes, writer sees it live.
      readerHandle.change(d => {
        d.items.push("third")
      })
      await awaitDoc(
        writerHandle,
        h => h.doc()?.items?.includes("third") ?? false,
        { timeout: 5000 }
      )
    }, 20_000)
  }
)
