/**
 * Does a worker that accepts a tab over a *Subduction* MessageChannel relay the
 * tab's document onward to an upstream WebSocket sync server?
 *
 * This is the patchwork tab→worker→server topology with the tab↔worker hop
 * switched from classic sync to Subduction:
 *
 *   tab ──MessageChannel/subduction──▸ worker ──WebSocket/subduction──▸ server
 *         (connect)            (accept)        (subductionWebsocketEndpoints)
 *
 * Unlike client→client relay (where the receiver pulls), the server is passive,
 * so the worker must push. That only happens if the worker has a sync entry for
 * the doc — which, with classic sync gone, nothing creates unless the worker
 * relays inbound sedimentrees. This test pins down whether that works.
 */

import { describe, it, expect, afterEach } from "vitest"
import { WebSocketServer } from "ws"
import {
  Subduction,
  MemorySigner,
  MemoryStorage,
} from "@automerge/automerge-subduction"
import { MessageChannelNetworkAdapter } from "../../../automerge-repo-network-messagechannel/src/index.js"
import { Repo } from "../../src/Repo.js"
import { DummyStorageAdapter } from "../../src/helpers/DummyStorageAdapter.js"
import { type PeerId } from "../../src/types.js"
import { WebSocketTransport } from "../../src/subduction/websocket-transport.js"
import { toSedimentreeId } from "../../src/subduction/helpers.js"
import { pause } from "../../src/helpers/pause.js"

const SERVICE = "patchwork-tab-worker"

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

describe("Subduction tab→worker→server relay (MessageChannel accept)", () => {
  const cleanups: Array<() => Promise<void> | void> = []
  afterEach(async () => {
    for (const c of cleanups.reverse()) await c()
    cleanups.length = 0
  })

  async function startServer() {
    const tmp = new WebSocketServer({ port: 0 })
    await new Promise<void>(r => tmp.on("listening", r))
    const addr = tmp.address()
    if (typeof addr === "string") throw new Error("unexpected address type")
    const port = (addr as { port: number }).port
    await new Promise<void>((r, e) => tmp.close(err => (err ? e(err) : r())))

    const signer = new MemorySigner()
    const storage = new MemoryStorage()
    const subduction = new Subduction({ signer, storage })
    const serviceName = `localhost:${port}`

    const wss = new WebSocketServer({ port })
    await new Promise<void>(r => wss.on("listening", r))
    wss.on("connection", ws => {
      const transport = new WebSocketTransport(ws as any)
      subduction.acceptTransport(transport, serviceName).catch(() => {})
    })

    cleanups.push(async () => {
      await subduction.disconnectAll().catch(() => {})
      await new Promise<void>(r => wss.close(() => r()))
    })

    return { url: `ws://localhost:${port}`, subduction }
  }

  it("relays a tab-created doc up to the server", async () => {
    const server = await startServer()

    const worker = new Repo({
      peerId: "worker" as PeerId,
      storage: new DummyStorageAdapter(),
      network: [],
      sharePolicy: async () => true,
      subductionWebsocketEndpoints: [server.url],
      subductionRelay: true,
    })

    const channel = new MessageChannel()
    const workerSide = new MessageChannelNetworkAdapter(channel.port1, {
      useWeakRef: false,
    })
    const tabSide = new MessageChannelNetworkAdapter(channel.port2, {
      useWeakRef: false,
    })
    worker.addSubductionAdapter(workerSide, SERVICE, "accept")

    const tab = new Repo({
      peerId: "tab" as PeerId,
      network: [],
      sharePolicy: async () => true,
      subductionAdapters: [
        { adapter: tabSide, serviceName: SERVICE, role: "connect" },
      ],
    })
    cleanups.push(() => {
      worker.removeSubductionAdapter(workerSide)
      channel.port1.close()
      channel.port2.close()
    })

    const handle = tab.create<{ title: string }>()
    handle.change(d => {
      d.title = "from tab"
    })

    const sid = toSedimentreeId(handle.documentId)
    await waitForCondition(async () => {
      const blobs = await server.subduction.getBlobs(sid)
      return blobs !== undefined && blobs.length > 0
    }, 6000)

    const blobs = await server.subduction.getBlobs(sid)
    expect(blobs && blobs.length).toBeGreaterThan(0)
  }, 15_000)

  it("serves a tab a doc that exists only on the server (cold cross-device fetch)", async () => {
    const server = await startServer()

    // A "different device": a repo wired straight to the server creates a doc.
    const producer = new Repo({
      peerId: "producer" as PeerId,
      storage: new DummyStorageAdapter(),
      network: [],
      sharePolicy: async () => true,
      subductionWebsocketEndpoints: [server.url],
    })
    const produced = producer.create<{ title: string }>()
    produced.change(d => {
      d.title = "made elsewhere"
    })
    const sid = toSedimentreeId(produced.documentId)
    await waitForCondition(async () => {
      const blobs = await server.subduction.getBlobs(sid)
      return blobs !== undefined && blobs.length > 0
    }, 6000)

    // A fresh worker that has never seen this doc, plus a tab that asks for it.
    const worker = new Repo({
      peerId: "worker" as PeerId,
      storage: new DummyStorageAdapter(),
      network: [],
      sharePolicy: async () => true,
      subductionWebsocketEndpoints: [server.url],
      subductionRelay: true,
    })
    const channel = new MessageChannel()
    const workerSide = new MessageChannelNetworkAdapter(channel.port1, {
      useWeakRef: false,
    })
    const tabSide = new MessageChannelNetworkAdapter(channel.port2, {
      useWeakRef: false,
    })
    worker.addSubductionAdapter(workerSide, SERVICE, "accept")
    // Let the worker establish its (long-lived, in production) WebSocket
    // connection to the server before the tab asks for a cold doc, so the
    // relay fetch has the server in its peer set.
    await pause(1000)
    const tab = new Repo({
      peerId: "tab" as PeerId,
      network: [],
      sharePolicy: async () => true,
      subductionAdapters: [
        { adapter: tabSide, serviceName: SERVICE, role: "connect" },
      ],
    })
    cleanups.push(() => {
      worker.removeSubductionAdapter(workerSide)
      channel.port1.close()
      channel.port2.close()
    })

    const progress = tab.findWithProgress<{ title: string }>(produced.url)
    await waitForCondition(() => {
      const s = progress.peek()
      return s.state === "ready" && s.handle.doc()?.title === "made elsewhere"
    }, 8000)
    expect(progress.peek().state).toBe("ready")
  }, 20_000)
})
