/**
 * Real-browser (Playwright) tests for {@link WorkerWebSocketTransport}:
 * a real dedicated `Worker` running the shipped proxy host, speaking to a
 * real `ws` echo server started in the vitest Node process via browser
 * commands (see `test/helpers/wsEchoServerCommands.ts`).
 */
import { commands } from "vitest/browser"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { WorkerWebSocketTransport } from "../../src/subduction/worker-websocket/transport.js"
import { WorkerWebSocketEndpoint } from "../../src/subduction/websocket-endpoint.js"

declare module "vitest/internal/browser" {
  interface BrowserCommands {
    startEchoServer: () => Promise<{ port: number }>
    stopEchoServer: (port: number) => Promise<void>
    closeEchoClients: (port: number) => Promise<void>
    echoClientCount: (port: number) => Promise<number>
    reportBench: (
      label: string,
      rows: Array<Record<string, string | number>>
    ) => Promise<void>
    blastClients: (port: number, frames: number, bytes: number) => Promise<void>
    startFlood: (
      port: number,
      opts: { bytes: number; intervalMs: number; pingEveryMs: number }
    ) => Promise<void>
    stopFlood: (
      port: number
    ) => Promise<{ framesSent: number; pongTimestamps: number[] }>
    serverNow: () => Promise<number>
  }
}

const bytes = (...values: number[]) => new Uint8Array(values)

const waitUntil = async (
  predicate: () => Promise<boolean>,
  timeoutMs = 5_000
) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(r => setTimeout(r, 25))
  }
  throw new Error("waitUntil timed out")
}

describe("WorkerWebSocketTransport (real Worker, real WebSocket)", () => {
  let worker: Worker
  let port: number
  let url: string
  const openTransports: WorkerWebSocketTransport[] = []

  const connect = async (targetUrl = url) => {
    const transport = await WorkerWebSocketTransport.connect(worker, targetUrl)
    openTransports.push(transport)
    return transport
  }

  beforeAll(async () => {
    worker = new Worker(
      new URL(
        "../../src/subduction/worker-websocket/worker-entry.ts",
        import.meta.url
      ),
      { type: "module" }
    )
    const started = await commands.startEchoServer()
    port = started.port
    url = `ws://localhost:${port}`
  })

  afterEach(async () => {
    for (const transport of openTransports.splice(0)) {
      await transport.disconnect()
    }
  })

  afterAll(async () => {
    await commands.stopEchoServer(port)
    worker.terminate()
  })

  it("connects and roundtrips bytes through the worker", async () => {
    const transport = await connect()

    await transport.sendBytes(bytes(1, 2, 3, 255))
    const echoed = await transport.recvBytes()

    expect(Array.from(echoed)).toEqual([1, 2, 3, 255])
  })

  it("preserves ordering across queued and awaited receives", async () => {
    const transport = await connect()

    // Fire three sends; echoes may land before or after each recvBytes
    // call, exercising both the queue path and the waiter path.
    await transport.sendBytes(bytes(1))
    await transport.sendBytes(bytes(2))
    const first = await transport.recvBytes()
    await transport.sendBytes(bytes(3))
    const second = await transport.recvBytes()
    const third = await transport.recvBytes()

    expect([first[0], second[0], third[0]]).toEqual([1, 2, 3])
  })

  it("roundtrips a large payload intact", async () => {
    const transport = await connect()

    const big = new Uint8Array(1 << 20) // 1 MiB
    for (let i = 0; i < big.length; i++) big[i] = i % 251

    await transport.sendBytes(big)
    const echoed = await transport.recvBytes()

    expect(echoed.length).toBe(big.length)
    expect(echoed.every((v, i) => v === i % 251)).toBe(true)
  })

  it("sendBytes leaves the caller's buffer intact", async () => {
    const transport = await connect()

    const payload = bytes(9, 8, 7)
    await transport.sendBytes(payload)
    // sendBytes transfers a copy; the caller's view must stay usable.
    expect(payload.byteLength).toBe(3)
    expect(Array.from(payload)).toEqual([9, 8, 7])
    expect(Array.from(await transport.recvBytes())).toEqual([9, 8, 7])
  })

  it("multiplexes two transports over one worker without cross-talk", async () => {
    const a = await connect()
    const b = await connect()

    await a.sendBytes(bytes(10))
    await b.sendBytes(bytes(20))
    await a.sendBytes(bytes(11))
    await b.sendBytes(bytes(21))

    expect([(await a.recvBytes())[0], (await a.recvBytes())[0]]).toEqual([
      10, 11,
    ])
    expect([(await b.recvBytes())[0], (await b.recvBytes())[0]]).toEqual([
      20, 21,
    ])
  })

  it("resolves closed() and rejects pending recvBytes on server close", async () => {
    const transport = await connect()

    const pendingRecv = transport.recvBytes()
    await commands.closeEchoClients(port)

    await transport.closed()
    await expect(pendingRecv).rejects.toThrow("WebSocket closed")
    await expect(transport.recvBytes()).rejects.toThrow("WebSocket closed")
    await expect(transport.sendBytes(bytes(1))).rejects.toThrow(
      "WebSocket closed"
    )
  })

  it("rejects connect() for an unreachable endpoint", async () => {
    // Nothing listens on port 1. Bound the deadline so an environment that
    // silently drops the connection (instead of refusing it) still fails
    // fast, and assert the failure shape rather than accepting any error.
    await expect(
      WorkerWebSocketTransport.connect(worker, "ws://localhost:1", {
        connectTimeoutMs: 2_000,
      })
    ).rejects.toThrow(/WebSocket (error|connection failed|connect timed out)/)
  })

  it("closes the server-side socket on disconnect()", async () => {
    const before = await commands.echoClientCount(port)
    const transport = await connect()
    await waitUntil(async () => (await commands.echoClientCount(port)) > before)

    await transport.disconnect()

    await waitUntil(
      async () => (await commands.echoClientCount(port)) <= before
    )
  })
})

describe("WorkerWebSocketEndpoint (auto-spawned worker)", () => {
  let port: number

  beforeAll(async () => {
    const started = await commands.startEchoServer()
    port = started.port
  })

  afterAll(async () => {
    await commands.stopEchoServer(port)
  })

  it("spawns its own worker, roundtrips, and reconnects after close", async () => {
    const endpoint = new WorkerWebSocketEndpoint(`ws://localhost:${port}`)

    const first = await endpoint.connect()
    await first.sendBytes(bytes(42))
    expect((await first.recvBytes())[0]).toBe(42)
    await first.disconnect()

    // The reconnect loop calls connect() repeatedly on one endpoint; a
    // second connection must work on the same (still-alive) worker.
    const second = await endpoint.connect()
    await second.sendBytes(bytes(43))
    expect((await second.recvBytes())[0]).toBe(43)
    await second.disconnect()

    endpoint.shutdown()
  })

  it("terminates its owned worker on shutdown", async () => {
    const endpoint = new WorkerWebSocketEndpoint(`ws://localhost:${port}`)
    await endpoint.connect()
    await waitUntil(async () => (await commands.echoClientCount(port)) > 0)

    // Terminating the worker kills the socket — the server must observe
    // the connection drop without an explicit transport.disconnect().
    endpoint.shutdown()

    await waitUntil(async () => (await commands.echoClientCount(port)) === 0)
  })
})

describe("receive flow control", () => {
  const seqOf = (frame: Uint8Array): number =>
    new DataView(frame.buffer, frame.byteOffset).getUint32(0, true)

  const withServer = async (
    run: (port: number, url: string) => Promise<void>
  ) => {
    const { port } = await commands.startEchoServer()
    try {
      await run(port, `ws://localhost:${port}`)
    } finally {
      await commands.stopEchoServer(port)
    }
  }

  it("keeps pongs flowing and loses nothing while the main thread is wedged", async () => {
    await withServer(async (port, url) => {
      const endpoint = new WorkerWebSocketEndpoint(url)
      const transport = await endpoint.connect()

      // Server pushes a frame every 5ms and a protocol ping every 50ms,
      // recording pong timestamps Node-side.
      await commands.startFlood(port, {
        bytes: 32768,
        intervalMs: 5,
        pingEveryMs: 50,
      })

      const wedgeStart = await commands.serverNow()
      // Block the main thread synchronously; no events or acks run
      // meanwhile.
      const end = performance.now() + 1500
      while (performance.now() < end) {
        /* burn */
      }
      const wedgeEnd = await commands.serverNow()

      const { framesSent, pongTimestamps } = await commands.stopFlood(port)
      expect(framesSent).toBeGreaterThan(100)

      // Keepalives were answered during the wedge: the worker kept
      // draining the socket, so the network process kept parsing (and
      // ponging) pings. Trim the window at both ends — wedgeEnd is
      // captured over an RPC after the wedge releases, so pongs flushed
      // on unwedge could otherwise masquerade as in-wedge liveness — and
      // require well above one stray (~26 pings fit in 1500ms at 50ms).
      const pongsDuringWedge = pongTimestamps.filter(
        t => t > wedgeStart + 200 && t < wedgeEnd - 100
      )
      expect(pongsDuringWedge.length).toBeGreaterThan(10)

      // And nothing was lost or reordered: every frame arrives, in order.
      for (let seq = 0; seq < framesSent; seq++) {
        expect(seqOf(await transport.recvBytes())).toBe(seq)
      }

      await transport.disconnect()
      endpoint.shutdown()
    })
  })

  it("fail-fast closes with a distinct error when the byte cap is exceeded", async () => {
    await withServer(async (port, url) => {
      const endpoint = new WorkerWebSocketEndpoint(url, {
        windowFrames: 2,
        maxBufferedBytes: 64_000,
      })
      const transport = await endpoint.connect()

      // Never consume: 2 frames fill the window, the rest pile up in the
      // worker — 100 × 4096B ≈ 400KB blows the 64KB cap.
      await commands.blastClients(port, 100, 4096)

      await transport.closed()

      // The two windowed frames were already delivered; they drain first.
      expect(seqOf(await transport.recvBytes())).toBe(0)
      expect(seqOf(await transport.recvBytes())).toBe(1)
      await expect(transport.recvBytes()).rejects.toThrow(/maxBufferedBytes/)

      endpoint.shutdown()
    })
  })

  it("refills the window via acks: many frames cross a tiny window in order", async () => {
    await withServer(async (port, url) => {
      const endpoint = new WorkerWebSocketEndpoint(url, { windowFrames: 4 })
      const transport = await endpoint.connect()

      await commands.blastClients(port, 200, 256)

      for (let seq = 0; seq < 200; seq++) {
        expect(seqOf(await transport.recvBytes())).toBe(seq)
      }

      await transport.disconnect()
      endpoint.shutdown()
    })
  })

  it("rejects connect() after the deadline when the worker never responds", async () => {
    // A bare MessagePort with no host attached: messages go nowhere.
    const dead = new MessageChannel().port1
    const start = performance.now()

    await expect(
      WorkerWebSocketTransport.connect(dead, "ws://localhost:1", {
        connectTimeoutMs: 300,
      })
    ).rejects.toThrow(/timed out/)

    expect(performance.now() - start).toBeGreaterThanOrEqual(250)
  })

  it("shutdown() fails pending recvBytes before terminating the worker", async () => {
    await withServer(async (_port, url) => {
      const endpoint = new WorkerWebSocketEndpoint(url)
      const transport = await endpoint.connect()

      const pending = transport.recvBytes()
      endpoint.shutdown() // hard-terminates the auto-spawned worker

      await expect(pending).rejects.toThrow(/shut down/)
      await transport.closed() // resolves — no hang
    })
  })
})
