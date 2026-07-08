/**
 * Socket-owning logic behind `websocket.worker.ts`, factored out so it can be
 * tested without a browser. Owns one socket: decodes inbound frames, encodes
 * outbound, and reconnects on close. Reports via the injected `post`.
 */
import { decode, encode } from "@automerge/automerge-repo/helpers/cbor.js"

import type { FromServerMessage } from "./messages.js"
import { toArrayBuffer } from "./toArrayBuffer.js"
import {
  WS_WORKER_RPC,
  type WsWorkerCommand,
  type WsWorkerEventBody,
} from "./websocket-worker-rpc.js"

/** The minimal slice of `WebSocket` this needs (so tests can fake it). */
export interface WsSocketLike {
  binaryType: string
  send(data: ArrayBuffer): void
  close(): void
  addEventListener(
    type: string,
    listener: (event: { data?: unknown }) => void
  ): void
  removeEventListener(
    type: string,
    listener: (event: { data?: unknown }) => void
  ): void
}

export interface WebSocketWorkerHandlerOptions {
  createSocket: (url: string) => WsSocketLike
  post: (event: WsWorkerEventBody) => void
}

/** Returns a handler for inbound {@link WsWorkerCommand}s. */
export function makeWebSocketWorkerHandler({
  createSocket,
  post,
}: WebSocketWorkerHandlerOptions) {
  let socket: WsSocketLike | undefined
  let isOpen = false
  let url = ""
  let retryInterval = 5000
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  // `disconnect` sets this so the socket's `close` event doesn't reconnect.
  let stopped = false

  const clearRetry = () => {
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer)
      retryTimer = undefined
    }
  }

  const scheduleReconnect = () => {
    if (!stopped && retryInterval > 0 && retryTimer === undefined) {
      retryTimer = setTimeout(() => {
        retryTimer = undefined
        openSocket()
      }, retryInterval)
    }
  }

  function openSocket() {
    let ws: WsSocketLike
    try {
      ws = createSocket(url)
    } catch {
      post({ type: "error" })
      scheduleReconnect()
      return
    }
    socket = ws
    isOpen = false
    ws.binaryType = "arraybuffer"

    ws.addEventListener("open", () => {
      isOpen = true
      clearRetry()
      post({ type: "open" })
    })
    ws.addEventListener("message", event => {
      try {
        const message = decode(
          new Uint8Array(event.data as ArrayBuffer)
        ) as FromServerMessage
        post({ type: "message", message })
      } catch {
        // drop undecodable frames
      }
    })
    ws.addEventListener("close", () => {
      isOpen = false
      post({ type: "close" })
      scheduleReconnect()
    })
    ws.addEventListener("error", () => {
      post({ type: "error" })
    })
  }

  return function handleCommand(command: WsWorkerCommand): void {
    if (!command || command.channel !== WS_WORKER_RPC) return
    switch (command.type) {
      case "connect":
        stopped = false
        url = command.url
        retryInterval = command.retryInterval
        openSocket()
        return
      case "send":
        if (socket && isOpen)
          socket.send(toArrayBuffer(encode(command.message)))
        return
      case "disconnect":
        stopped = true
        clearRetry()
        isOpen = false
        socket?.close()
        socket = undefined
        return
    }
  }
}
