/**
 * Node-side vitest browser commands backing the worker-websocket Playwright
 * tests. The browser test can't spawn a WebSocket server itself, so these
 * commands run in the vitest Node process and are invoked from the browser
 * via `commands.*` (see `vitest.browser.config.ts`).
 */

import { WebSocketServer } from "ws"

const servers = new Map<number, WebSocketServer>()

interface FloodState {
  timer: ReturnType<typeof setInterval>
  framesSent: number
  /** `Date.now()` timestamps of protocol pongs received from clients. */
  pongTimestamps: number[]
}

const floods = new Map<number, FloodState>()

/** A frame whose first 4 bytes carry a little-endian sequence number. */
const seqFrame = (seq: number, bytes: number): Buffer => {
  const buf = Buffer.alloc(Math.max(4, bytes))
  buf.writeUInt32LE(seq, 0)
  return buf
}

/** Start a binary echo server on an ephemeral port; returns the port. */
const startEchoServer = async (): Promise<{ port: number }> => {
  const wss = new WebSocketServer({ port: 0 })
  await new Promise<void>(resolve => wss.once("listening", resolve))

  wss.on("connection", socket => {
    socket.on("message", data => {
      socket.send(data, { binary: true })
    })
  })

  const address = wss.address()
  if (address === null || typeof address === "string")
    throw new Error("echo server has no port")

  servers.set(address.port, wss)
  return { port: address.port }
}

const stopEchoServer = async (_ctx: unknown, port: number): Promise<void> => {
  const wss = servers.get(port)
  if (!wss) return
  servers.delete(port)
  for (const client of wss.clients) client.terminate()
  await new Promise<void>(resolve => wss.close(() => resolve()))
}

/** Force-close every client connection (server-initiated close). */
const closeEchoClients = async (_ctx: unknown, port: number): Promise<void> => {
  const wss = servers.get(port)
  if (!wss) return
  for (const client of wss.clients) client.close()
}

const echoClientCount = async (_ctx: unknown, port: number): Promise<number> =>
  servers.get(port)?.clients.size ?? 0

/**
 * Push `frames` seq-numbered frames of `bytes` each to every client,
 * immediately. Used to overrun the receive window / byte cap.
 */
const blastClients = async (
  _ctx: unknown,
  port: number,
  frames: number,
  bytes: number
): Promise<void> => {
  const wss = servers.get(port)
  if (!wss) throw new Error(`no server on port ${port}`)
  for (const client of wss.clients) {
    for (let seq = 0; seq < frames; seq++) {
      client.send(seqFrame(seq, bytes), { binary: true })
    }
  }
}

/**
 * Start a Node-side timer that pushes one seq-numbered frame of `bytes` to
 * every client each `intervalMs`, and sends a protocol ping each
 * `pingEveryMs`. Pong arrival timestamps are recorded server-side, so
 * tests can check keepalive liveness while the browser main thread is
 * blocked.
 */
const startFlood = async (
  _ctx: unknown,
  port: number,
  opts: { bytes: number; intervalMs: number; pingEveryMs: number }
): Promise<void> => {
  const wss = servers.get(port)
  if (!wss) throw new Error(`no server on port ${port}`)
  if (floods.has(port)) throw new Error(`flood already running on ${port}`)

  const state: FloodState = {
    framesSent: 0,
    pongTimestamps: [],
    timer: 0 as never,
  }
  for (const client of wss.clients) {
    client.on("pong", () => state.pongTimestamps.push(Date.now()))
  }

  let sinceLastPing = 0
  state.timer = setInterval(() => {
    for (const client of wss.clients) {
      client.send(seqFrame(state.framesSent, opts.bytes), { binary: true })
    }
    state.framesSent++
    sinceLastPing += opts.intervalMs
    if (sinceLastPing >= opts.pingEveryMs) {
      sinceLastPing = 0
      for (const client of wss.clients) client.ping()
    }
  }, opts.intervalMs)

  floods.set(port, state)
}

/** Stop the flood and return what the server observed. */
const stopFlood = async (
  _ctx: unknown,
  port: number
): Promise<{ framesSent: number; pongTimestamps: number[] }> => {
  const state = floods.get(port)
  if (!state) throw new Error(`no flood running on ${port}`)
  floods.delete(port)
  clearInterval(state.timer)
  return { framesSent: state.framesSent, pongTimestamps: state.pongTimestamps }
}

/** `Date.now()` on the Node side, for cross-context timestamp comparison. */
const serverNow = async (): Promise<number> => Date.now()

/** Print bench results on the Node side (browser console isn't forwarded). */
const reportBench = async (
  _ctx: unknown,
  label: string,
  rows: Array<Record<string, string | number>>
): Promise<void> => {
  console.log(`\n${label}`)
  console.table(rows)
}

export const wsEchoServerCommands = {
  blastClients,
  closeEchoClients,
  echoClientCount,
  reportBench,
  serverNow,
  startEchoServer,
  startFlood,
  stopEchoServer,
  stopFlood,
}
