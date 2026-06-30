import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { decode, encode } from "@automerge/automerge-repo/helpers/cbor.js"
import type { PeerId } from "@automerge/automerge-repo/slim"

import {
  makeWebSocketWorkerHandler,
  type WsSocketLike,
} from "../src/websocket-worker-handler.js"
import {
  WS_WORKER_RPC,
  type WsWorkerCommand,
  type WsWorkerEventBody,
} from "../src/websocket-worker-rpc.js"

const peer = (s: string) => s as PeerId

class FakeSocket implements WsSocketLike {
  binaryType = ""
  sent: ArrayBuffer[] = []
  closed = false
  #listeners: Record<string, Set<(e: { data?: unknown }) => void>> = {
    open: new Set(),
    message: new Set(),
    close: new Set(),
    error: new Set(),
  }

  addEventListener(type: string, fn: (e: { data?: unknown }) => void) {
    this.#listeners[type]?.add(fn)
  }
  removeEventListener(type: string, fn: (e: { data?: unknown }) => void) {
    this.#listeners[type]?.delete(fn)
  }
  send(data: ArrayBuffer) {
    this.sent.push(data)
  }
  close() {
    this.closed = true
    this.#emit("close")
  }

  fireOpen() {
    this.#emit("open")
  }
  fireError() {
    this.#emit("error")
  }
  deliver(bytes: Uint8Array) {
    // Exact-size copy: a Node Buffer's `.buffer` is an oversized shared pool.
    const copy = new Uint8Array(bytes)
    this.#emit("message", { data: copy.buffer })
  }
  #emit(type: string, e: { data?: unknown } = {}) {
    for (const fn of this.#listeners[type] ?? []) fn(e)
  }
}

const connect = (url = "wss://x", retryInterval = 5000): WsWorkerCommand => ({
  channel: WS_WORKER_RPC,
  type: "connect",
  url,
  retryInterval,
})

describe("websocket worker handler", () => {
  let sockets: FakeSocket[]
  let events: WsWorkerEventBody[]
  let handle: (c: WsWorkerCommand) => void

  beforeEach(() => {
    vi.useFakeTimers()
    sockets = []
    events = []
    handle = makeWebSocketWorkerHandler({
      createSocket: () => {
        const s = new FakeSocket()
        sockets.push(s)
        return s
      },
      post: e => events.push(e),
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("opens a socket and reports open", () => {
    handle(connect())
    expect(sockets).toHaveLength(1)
    expect(sockets[0].binaryType).toBe("arraybuffer")
    sockets[0].fireOpen()
    expect(events).toContainEqual({ type: "open" })
  })

  it("decodes inbound frames and posts them", () => {
    handle(connect())
    sockets[0].fireOpen()
    const message = {
      type: "peer",
      senderId: peer("server"),
      peerMetadata: {},
      selectedProtocolVersion: "1",
      targetId: peer("client"),
    }
    sockets[0].deliver(encode(message))
    expect(events).toContainEqual({ type: "message", message })
  })

  it("only sends once open, and encodes the frame", () => {
    handle(connect())
    const message = {
      type: "join",
      senderId: peer("client"),
      peerMetadata: {},
      supportedProtocolVersions: ["1"],
    }
    handle({ channel: WS_WORKER_RPC, type: "send", message: message as never })
    expect(sockets[0].sent).toHaveLength(0) // not open yet

    sockets[0].fireOpen()
    handle({ channel: WS_WORKER_RPC, type: "send", message: message as never })
    expect(sockets[0].sent).toHaveLength(1)
    expect(decode(new Uint8Array(sockets[0].sent[0]))).toEqual(message)
  })

  it("reconnects after the retry interval on close", () => {
    handle(connect("wss://x", 5000))
    sockets[0].fireOpen()
    sockets[0].close() // server-side drop
    expect(events).toContainEqual({ type: "close" })
    expect(sockets).toHaveLength(1)

    vi.advanceTimersByTime(5000)
    expect(sockets).toHaveLength(2) // reconnected
  })

  it("does not reconnect after an explicit disconnect", () => {
    handle(connect("wss://x", 5000))
    sockets[0].fireOpen()
    handle({ channel: WS_WORKER_RPC, type: "disconnect" })
    expect(sockets[0].closed).toBe(true)

    vi.advanceTimersByTime(60_000)
    expect(sockets).toHaveLength(1) // stayed disconnected
  })

  it("reports an error and reconnects when the socket constructor throws", () => {
    let attempts = 0
    const h = makeWebSocketWorkerHandler({
      createSocket: () => {
        attempts++
        if (attempts === 1) throw new Error("boom")
        const s = new FakeSocket()
        sockets.push(s)
        return s
      },
      post: e => events.push(e),
    })
    h(connect("wss://x", 1000))
    expect(events).toContainEqual({ type: "error" })
    vi.advanceTimersByTime(1000)
    expect(attempts).toBe(2)
  })
})
