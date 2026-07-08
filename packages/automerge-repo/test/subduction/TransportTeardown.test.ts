/**
 * Locally-initiated transport teardown must not deliver frames to the
 * Wasm afterwards. `recvBytes()` serves its internal queue before
 * checking the closed flag, so dropping the queue (and rejecting
 * pending receivers) at teardown is the only thing standing between a
 * buffered frame and a post-shutdown dispatch against closing storage.
 *
 * Remote close is different: frames received before the peer closed are
 * still delivered (both transports keep their queue on `close`/`ws-closed`).
 */

import { describe, expect, it } from "vitest"

import { WebSocketTransport } from "../../src/subduction/websocket-transport.js"
import { WorkerWebSocketTransport } from "../../src/subduction/worker-websocket/transport.js"
import {
  WS_PROXY_CHANNEL,
  WS_PROXY_PROTOCOL_VERSION,
  type WorkerPortLike,
  type WsProxyRequest,
  type WsProxyResponse,
} from "../../src/subduction/worker-websocket/protocol.js"

// ─── In-thread WebSocketTransport ────────────────────────────────────────

type WsListener = (event: any) => void

/** Minimal stand-in for a `ws`/browser WebSocket. */
class FakeWebSocket {
  binaryType = ""
  sent: Uint8Array[] = []
  closeCalls = 0
  #listeners = new Map<string, WsListener[]>()

  addEventListener(type: string, listener: WsListener) {
    const list = this.#listeners.get(type) ?? []
    list.push(listener)
    this.#listeners.set(type, list)
  }

  removeEventListener(type: string, listener: WsListener) {
    const list = this.#listeners.get(type) ?? []
    const i = list.indexOf(listener)
    if (i !== -1) list.splice(i, 1)
  }

  send(bytes: Uint8Array) {
    this.sent.push(bytes)
  }

  close() {
    this.closeCalls++
  }

  emit(type: string, event: unknown) {
    for (const listener of this.#listeners.get(type) ?? []) listener(event)
  }

  emitMessage(bytes: Uint8Array) {
    this.emit("message", { data: bytes.buffer })
  }
}

const frame = (n: number) => new Uint8Array([n])

describe("WebSocketTransport teardown", () => {
  it("drops queued frames on disconnect()", async () => {
    const ws = new FakeWebSocket()
    const transport = new WebSocketTransport(ws as any)

    // Two frames arrive with no pending receiver: both queue.
    ws.emitMessage(frame(1))
    ws.emitMessage(frame(2))

    await transport.disconnect()

    // Without the queue-drop, this would resolve with frame(1).
    await expect(transport.recvBytes()).rejects.toThrow(/closed/i)
    expect(ws.closeCalls).toBe(1)
  })

  it("rejects a pending receiver immediately on disconnect()", async () => {
    const ws = new FakeWebSocket()
    const transport = new WebSocketTransport(ws as any)

    // recvBytes with nothing queued: parks a waiter.
    const pending = transport.recvBytes()

    // Rejection must not wait for the ws close handshake (the fake
    // never emits "close", mimicking an unresponsive peer).
    await transport.disconnect()
    await expect(pending).rejects.toThrow(/closed/i)
  })

  it("ignores frames still buffered in the socket after teardown", async () => {
    const ws = new FakeWebSocket()
    const transport = new WebSocketTransport(ws as any)

    await transport.disconnect()

    // A frame the socket had already buffered fires after teardown; it
    // must be neither queued nor handed to a future receiver.
    ws.emitMessage(frame(3))
    await expect(transport.recvBytes()).rejects.toThrow(/closed/i)
  })

  it("still delivers queued frames after a remote close", async () => {
    const ws = new FakeWebSocket()
    const transport = new WebSocketTransport(ws as any)

    ws.emitMessage(frame(4))
    ws.emit("close", {})

    // Remote-close semantics are unchanged: the tail is readable.
    await expect(transport.recvBytes()).resolves.toEqual(frame(4))
    await expect(transport.recvBytes()).rejects.toThrow(/closed/i)
  })
})

// ─── Worker-hosted WorkerWebSocketTransport ──────────────────────────────

/** Records outbound proxy requests and lets tests inject responses. */
class FakePort implements WorkerPortLike {
  posted: WsProxyRequest[] = []
  // Keyed by event type: the transport registers both "message" and
  // "close" listeners, and only "message" listeners may see responses.
  #listeners = new Map<string, Array<(event: MessageEvent) => void>>()

  postMessage(message: unknown) {
    const msg = message as WsProxyRequest
    this.posted.push(msg)
    // Auto-open every connection attempt.
    if (msg.type === "ws-connect") {
      queueMicrotask(() =>
        this.respond({
          channel: WS_PROXY_CHANNEL,
          type: "ws-open",
          connId: msg.connId,
        })
      )
    }
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    const list = this.#listeners.get(type) ?? []
    list.push(listener)
    this.#listeners.set(type, list)
  }

  removeEventListener(type: string, listener: (event: MessageEvent) => void) {
    const list = this.#listeners.get(type) ?? []
    const i = list.indexOf(listener)
    if (i !== -1) list.splice(i, 1)
  }

  get listenerCount() {
    return (this.#listeners.get("message") ?? []).length
  }

  respond(msg: WsProxyResponse) {
    // Stamp the protocol version like the real host does.
    const data = { v: WS_PROXY_PROTOCOL_VERSION, ...msg }
    for (const listener of [...(this.#listeners.get("message") ?? [])]) {
      listener({ data } as MessageEvent)
    }
  }

  bytes(connId: string, payload: Uint8Array) {
    this.respond({
      channel: WS_PROXY_CHANNEL,
      type: "ws-bytes",
      connId,
      buf: payload.slice().buffer,
    })
  }

  get connId(): string {
    const connect = this.posted.find(m => m.type === "ws-connect")
    if (!connect) throw new Error("no ws-connect posted")
    return connect.connId
  }
}

async function connectedTransport() {
  const port = new FakePort()
  const transport = await WorkerWebSocketTransport.connect(
    port,
    "ws://example.invalid"
  )
  return { port, transport }
}

describe("WorkerWebSocketTransport teardown", () => {
  it("drops queued frames and posts ws-close on disconnect()", async () => {
    const { port, transport } = await connectedTransport()

    port.bytes(port.connId, frame(1))
    port.bytes(port.connId, frame(2))

    await transport.disconnect()

    await expect(transport.recvBytes()).rejects.toMatchObject({
      code: "disconnected",
    })
    // Best-effort ws-close still went to the (possibly shared) worker.
    expect(port.posted.some(m => m.type === "ws-close")).toBe(true)
  })

  it("drops queued frames and rejects receivers on abort()", async () => {
    const { port, transport } = await connectedTransport()

    port.bytes(port.connId, frame(1))
    const pending = transport.recvBytes() // consumes frame(1)
    await pending
    port.bytes(port.connId, frame(2)) // queues

    transport.abort()

    await expect(transport.recvBytes()).rejects.toMatchObject({
      code: "worker-terminated",
    })
    expect(port.posted.some(m => m.type === "ws-close")).toBe(true)
  })

  it("detaches its port listener on teardown", async () => {
    const { port, transport } = await connectedTransport()
    expect(port.listenerCount).toBe(1)

    await transport.disconnect()
    expect(port.listenerCount).toBe(0)

    // A late frame across the port hop is ignored entirely.
    port.bytes(port.connId, frame(9))
    await expect(transport.recvBytes()).rejects.toMatchObject({
      code: "disconnected",
    })
  })

  it("still delivers queued frames after a remote ws-closed", async () => {
    const { port, transport } = await connectedTransport()

    port.bytes(port.connId, frame(7))
    port.respond({
      channel: WS_PROXY_CHANNEL,
      type: "ws-closed",
      connId: port.connId,
    })

    // Remote-close semantics are unchanged: the tail is readable.
    await expect(transport.recvBytes()).resolves.toEqual(frame(7))
    await expect(transport.recvBytes()).rejects.toMatchObject({
      code: "closed",
    })
  })
})
