// @vitest-environment node
/**
 * Node-side tests for the worker-websocket proxy. Two tiers:
 *
 * 1. In-process: host + transport wired over a `worker_threads`
 *    `MessageChannel` with an injected fake socket — exercises the credit
 *    window, byte cap, and close-with-backlog flush without any threads.
 *
 * 2. Real threads (gated on `dist/` being built): the shipped Node worker
 *    entry running in an actual `worker_threads.Worker` with Node's native
 *    (undici) `WebSocket`, against a real `ws` server. Includes the wedge
 *    test: keepalive pongs must be answered while the test's own thread is
 *    blocked in a synchronous busy-loop.
 */
import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { pathToFileURL } from "node:url"
import {
  MessageChannel as NodeMessageChannel,
  Worker as NodeWorker,
} from "node:worker_threads"
import { afterEach, describe, expect, it } from "vitest"
import { WebSocketServer } from "ws"

import {
  attachWebSocketHost,
  type WebSocketLike,
} from "../../src/subduction/worker-websocket/host.js"
import { WorkerWebSocketTransport } from "../../src/subduction/worker-websocket/transport.js"
import { WorkerWebSocketEndpoint } from "../../src/subduction/websocket-endpoint.js"
import {
  WorkerWebSocketError,
  type WorkerPortLike,
} from "../../src/subduction/worker-websocket/protocol.js"

// Under happy-dom `import.meta.url` is not a file: URL, so locate the
// package root from cwd (vitest runs either at the repo root or in the
// package directory).
const DIST_ENTRY_REL = "dist/subduction/worker-websocket/worker-entry-node.js"
const pkgRoot = [
  process.cwd(),
  path.resolve(process.cwd(), "packages/automerge-repo"),
].find(root => existsSync(path.join(root, DIST_ENTRY_REL)))

const distEntry = pkgRoot ? path.join(pkgRoot, DIST_ENTRY_REL) : null
const require = createRequire(
  pathToFileURL(path.join(pkgRoot ?? process.cwd(), "package.json"))
)

const seqFrame = (seq: number, bytes = 4): ArrayBuffer => {
  const buf = new ArrayBuffer(Math.max(4, bytes))
  new DataView(buf).setUint32(0, seq, true)
  return buf
}

const seqOf = (frame: Uint8Array): number =>
  new DataView(frame.buffer, frame.byteOffset).getUint32(0, true)

const tick = () => new Promise(r => setTimeout(r, 0))

// ── Tier 1: in-process, fake socket ─────────────────────────────────────

class FakeSocket implements WebSocketLike {
  binaryType = ""
  sent: Uint8Array[] = []
  closed = false
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  #listeners = new Map<string, Array<(event: any) => void>>()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addEventListener(type: string, listener: (event: any) => void): void {
    const list = this.#listeners.get(type) ?? []
    list.push(listener)
    this.#listeners.set(type, list)
  }

  emit(type: string, event?: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event)
  }

  send(data: Uint8Array): void {
    this.sent.push(data)
  }

  close(): void {
    this.closed = true
    this.emit("close")
  }
}

describe("worker-websocket over MessageChannel (in-process)", () => {
  let detach: (() => void) | null = null
  let channel: InstanceType<typeof NodeMessageChannel> | null = null

  const setup = () => {
    channel = new NodeMessageChannel()
    const sockets: FakeSocket[] = []
    detach = attachWebSocketHost(channel.port2 as unknown as WorkerPortLike, {
      createSocket: () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        queueMicrotask(() => socket.emit("open"))
        return socket
      },
    })
    const getSocket = (index = -1) => {
      const socket = sockets.at(index)
      if (!socket) throw new Error("socket not created yet")
      return socket
    }
    return { port: channel.port1 as unknown as WorkerPortLike, getSocket }
  }

  afterEach(() => {
    detach?.()
    detach = null
    channel?.port1.close()
    channel = null
  })

  it("gates delivery at windowFrames until acks refill the window", async () => {
    const { port, getSocket } = setup()

    // Count ws-bytes deliveries independently of the transport.
    let delivered = 0
    const counter = (event: MessageEvent) => {
      const data = (event as { data?: { type?: string } }).data
      if (data?.type === "ws-bytes") delivered++
    }
    port.addEventListener("message", counter as (e: MessageEvent) => void)

    const transport = await WorkerWebSocketTransport.connect(port, "ws://x", {
      windowFrames: 2,
    })

    for (let seq = 0; seq < 6; seq++) {
      getSocket().emit("message", { data: seqFrame(seq) })
    }
    await tick()

    // Only the window's worth crossed; the rest wait in the "worker".
    expect(delivered).toBe(2)

    // Consuming acks and refills — everything arrives, in order.
    for (let seq = 0; seq < 6; seq++) {
      expect(seqOf(await transport.recvBytes())).toBe(seq)
    }
    expect(delivered).toBe(6)

    await transport.disconnect()
    port.removeEventListener("message", counter as (e: MessageEvent) => void)
  })

  it("fail-fast closes the socket when pendingBytes exceeds the cap", async () => {
    const { port, getSocket } = setup()
    const transport = await WorkerWebSocketTransport.connect(port, "ws://x", {
      windowFrames: 2,
      maxBufferedBytes: 100,
    })

    // 2 frames fill the window; 3 more × 64B = 192B pending > 100B cap.
    for (let seq = 0; seq < 5; seq++) {
      getSocket().emit("message", { data: seqFrame(seq, 64) })
    }

    await transport.closed()
    expect(getSocket().closed).toBe(true)

    // Windowed frames drain first, then the distinct error surfaces.
    expect(seqOf(await transport.recvBytes())).toBe(0)
    expect(seqOf(await transport.recvBytes())).toBe(1)
    const rejection = await transport.recvBytes().then(
      () => null,
      e => e as WorkerWebSocketError
    )
    expect(rejection?.code).toBe("backlog-exceeded")
    expect(rejection?.message).toMatch(/maxBufferedBytes/)
  })

  it("recovers after a cap breach: a new connection on the same port works", async () => {
    const { port, getSocket } = setup()
    const first = await WorkerWebSocketTransport.connect(port, "ws://x", {
      windowFrames: 1,
      maxBufferedBytes: 100,
    })

    // Breach the cap with nothing consuming.
    for (let seq = 0; seq < 5; seq++) {
      getSocket().emit("message", { data: seqFrame(seq, 64) })
    }
    await first.closed()

    // The reconnect loop's next attempt: same port, fresh connection.
    const second = await WorkerWebSocketTransport.connect(port, "ws://x", {
      windowFrames: 1,
      maxBufferedBytes: 100,
    })
    for (let seq = 0; seq < 3; seq++) {
      getSocket().emit("message", { data: seqFrame(seq) })
    }
    for (let seq = 0; seq < 3; seq++) {
      expect(seqOf(await second.recvBytes())).toBe(seq)
    }
    await second.disconnect()
  })

  it("ignores malformed acks instead of corrupting the window", async () => {
    const { port, getSocket } = setup()
    const transport = await WorkerWebSocketTransport.connect(port, "ws://x", {
      windowFrames: 2,
    })

    // A rogue oversized ack must not blow the window open (or wedge it).
    port.postMessage({
      channel: "subduction-ws-proxy",
      type: "ws-ack",
      connId: "nonsense",
      count: 999,
    })
    port.postMessage({
      channel: "subduction-ws-proxy",
      type: "ws-ack",
      connId: "nonsense",
      count: Number.NaN,
    })

    let delivered = 0
    const counter = (event: MessageEvent) => {
      const data = (event as { data?: { type?: string } }).data
      if (data?.type === "ws-bytes") delivered++
    }
    port.addEventListener("message", counter as (e: MessageEvent) => void)

    for (let seq = 0; seq < 6; seq++) {
      getSocket().emit("message", { data: seqFrame(seq) })
    }
    await tick()
    expect(delivered).toBe(2) // window still enforced

    for (let seq = 0; seq < 6; seq++) {
      expect(seqOf(await transport.recvBytes())).toBe(seq)
    }
    await transport.disconnect()
    port.removeEventListener("message", counter as (e: MessageEvent) => void)
  })

  it("shutting down one endpoint on a shared port leaves the other flowing", async () => {
    const { port, getSocket } = setup()

    const a = new WorkerWebSocketEndpoint("ws://a", { worker: port })
    const b = new WorkerWebSocketEndpoint("ws://b", { worker: port })
    const transportA = await a.connect()
    const transportB = await b.connect()
    const socketA = getSocket(0)
    const socketB = getSocket(1)

    const pendingA = transportA.recvBytes()
    a.shutdown()

    // A's transport fails and its worker-side socket closes…
    await expect(pendingA).rejects.toThrow(/shut down/)
    await tick()
    expect(socketA.closed).toBe(true)

    // …while B is untouched and still delivers.
    expect(socketB.closed).toBe(false)
    socketB.emit("message", { data: seqFrame(7) })
    expect(seqOf(await transportB.recvBytes())).toBe(7)

    await transportB.disconnect()
    b.shutdown()
  })

  it("flushes the pending backlog before reporting a socket close", async () => {
    const { port, getSocket } = setup()
    const transport = await WorkerWebSocketTransport.connect(port, "ws://x", {
      windowFrames: 1,
    })

    for (let seq = 0; seq < 3; seq++) {
      getSocket().emit("message", { data: seqFrame(seq) })
    }
    // Server closes while 2 frames are still held by the host.
    getSocket().emit("close")

    for (let seq = 0; seq < 3; seq++) {
      expect(seqOf(await transport.recvBytes())).toBe(seq)
    }
    await transport.closed()
    await expect(transport.recvBytes()).rejects.toThrow("WebSocket closed")
  })
})

// ── Tier 2: real worker_threads + real ws server ────────────────────────

describe.skipIf(distEntry === null)(
  "worker-websocket in a real worker_threads Worker (dist)",
  () => {
    const spawnHostWorker = () => {
      if (distEntry === null) throw new Error("unreachable: dist gated")
      const channel = new NodeMessageChannel()
      const worker = new NodeWorker(distEntry, {
        workerData: { port: channel.port2 },
        transferList: [channel.port2],
      })
      worker.unref()
      return {
        port: channel.port1 as unknown as WorkerPortLike,
        terminate: () => worker.terminate(),
      }
    }

    it("roundtrips through the shipped Node entry with native WebSocket", async () => {
      const wss = new WebSocketServer({ port: 0 })
      await new Promise<void>(r => wss.once("listening", r))
      const address = wss.address()
      if (address === null || typeof address === "string") throw new Error()
      wss.on("connection", socket =>
        socket.on("message", data => socket.send(data, { binary: true }))
      )

      const { port, terminate } = spawnHostWorker()
      const transport = await WorkerWebSocketTransport.connect(
        port,
        `ws://localhost:${address.port}`
      )

      await transport.sendBytes(new Uint8Array([1, 2, 3]))
      expect(Array.from(await transport.recvBytes())).toEqual([1, 2, 3])

      await transport.disconnect()
      await terminate()
      wss.close()
    })

    it("answers keepalive pongs while the main thread is wedged", async () => {
      // The pinging server must not share the thread we're about to wedge:
      // an eval-worker runs `ws` on its own event loop and records pongs.
      const wsPath = require.resolve("ws")
      const server = new NodeWorker(
        `
        const { parentPort, workerData } = require("node:worker_threads")
        const { WebSocketServer } = require(workerData.wsPath)
        const wss = new WebSocketServer({ port: 0 })
        const pongs = []
        wss.on("listening", () =>
          parentPort.postMessage({ port: wss.address().port }))
        wss.on("connection", socket => {
          socket.on("pong", () => pongs.push(Date.now()))
          const flood = setInterval(
            () => socket.send(Buffer.alloc(16384), { binary: true }), 5)
          const ping = setInterval(() => socket.ping(), 50)
          socket.on("close", () => { clearInterval(flood); clearInterval(ping) })
        })
        parentPort.on("message", () => parentPort.postMessage({ pongs }))
        `,
        { eval: true, workerData: { wsPath } }
      )
      const { port: serverPort } = await new Promise<{ port: number }>(r =>
        server.once("message", r)
      )

      const { port, terminate } = spawnHostWorker()
      const transport = await WorkerWebSocketTransport.connect(
        port,
        `ws://localhost:${serverPort}`
      )
      await new Promise(r => setTimeout(r, 200))

      // Wedge the test thread; the host and server workers keep running.
      const wedgeStart = Date.now()
      const end = Date.now() + 1500
      while (Date.now() < end) {
        /* burn */
      }
      const wedgeEnd = Date.now()

      const { pongs } = await new Promise<{ pongs: number[] }>(r => {
        server.on(
          "message",
          m => (m as { pongs?: number[] }).pongs && r(m as { pongs: number[] })
        )
        server.postMessage("report")
      })

      const during = pongs.filter(t => t > wedgeStart + 100 && t < wedgeEnd)
      expect(during.length).toBeGreaterThan(10)

      // The flood is still fully drainable afterward — nothing was lost to
      // a stalled socket.
      let received = 0
      const drainDeadline = Date.now() + 2000
      while (Date.now() < drainDeadline) {
        const raced = await Promise.race([
          transport.recvBytes().then(() => true),
          new Promise<false>(r => setTimeout(() => r(false), 250)),
        ])
        if (!raced) break
        received++
      }
      expect(received).toBeGreaterThan(50)

      await transport.disconnect()
      await terminate()
      await server.terminate()
    })

    it("endpoint auto-spawn resolves the Node entry from dist", async () => {
      // Import the BUILT endpoint so its import.meta.url-relative worker
      // URL points at dist/, exactly as consumers see it.
      const { WorkerWebSocketEndpoint } = (await import(
        pathToFileURL(
          path.join(pkgRoot ?? "", "dist/subduction/websocket-endpoint.js")
        ).href
      )) as typeof import("../../src/subduction/websocket-endpoint.js")

      const wss = new WebSocketServer({ port: 0 })
      await new Promise<void>(r => wss.once("listening", r))
      const address = wss.address()
      if (address === null || typeof address === "string") throw new Error()
      wss.on("connection", socket =>
        socket.on("message", data => socket.send(data, { binary: true }))
      )

      const endpoint = new WorkerWebSocketEndpoint(
        `ws://localhost:${address.port}`
      )
      const transport = await endpoint.connect()

      await transport.sendBytes(new Uint8Array([7]))
      expect((await transport.recvBytes())[0]).toBe(7)

      const pending = transport.recvBytes()
      endpoint.shutdown()
      await expect(pending).rejects.toThrow(/shut down/)

      await new Promise<void>((resolve, reject) =>
        wss.close(err => (err ? reject(err) : resolve()))
      )
    })
  }
)

// The tiers above skip when dist/ is missing (locally, before a build).
// In CI the build always precedes tests, so a closed gate there means the
// dist layout moved and the real-thread suites are silently not running.
it.runIf(process.env.CI)(
  "dist worker entry exists (gates the suites above)",
  () => {
    expect(distEntry).not.toBeNull()
  }
)
