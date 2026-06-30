/// <reference lib="webworker" />
/**
 * Worker entrypoint for {@link WebSocketWorkerClientAdapter}. Owns one
 * WebSocket, draining it continuously and doing CBOR encode/decode off the host
 * thread, so socket I/O and keepalives keep flowing even while the host is busy
 * with synchronous CRDT/Wasm work.
 *
 * Reconnect (with the host-provided retry interval) lives here too; the host
 * thread only sees `open`/`message`/`close`/`error` events and re-joins on each
 * `open`. Spawned by the adapter via
 * `new Worker(new URL("./websocket.worker.js", import.meta.url), { type: "module" })`.
 *
 * `cbor` is imported from the package's `helpers` subpath (not `/slim`) to keep
 * the worker bundle lean — no Repo/Subduction/Wasm glue.
 */
import { decode, encode } from "@automerge/automerge-repo/helpers/cbor.js"

import type { FromServerMessage } from "./messages.js"
import { toArrayBuffer } from "./toArrayBuffer.js"
import {
  WS_WORKER_RPC,
  type WsWorkerCommand,
  type WsWorkerEventBody,
} from "./websocket-worker-rpc.js"

let socket: WebSocket | undefined
let url = ""
let retryInterval = 5000
let retryTimer: ReturnType<typeof setTimeout> | undefined

const post = (event: WsWorkerEventBody) =>
  (self as unknown as Worker).postMessage({ channel: WS_WORKER_RPC, ...event })

function clearRetry() {
  if (retryTimer !== undefined) {
    clearTimeout(retryTimer)
    retryTimer = undefined
  }
}

function scheduleReconnect() {
  if (retryInterval > 0 && retryTimer === undefined) {
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      openSocket()
    }, retryInterval)
  }
}

function openSocket() {
  let ws: WebSocket
  try {
    ws = new WebSocket(url)
  } catch {
    post({ type: "error" })
    scheduleReconnect()
    return
  }
  socket = ws
  ws.binaryType = "arraybuffer"

  ws.addEventListener("open", () => {
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
      // Ignore an undecodable frame rather than tearing down the socket.
    }
  })
  ws.addEventListener("close", () => {
    post({ type: "close" })
    scheduleReconnect()
  })
  ws.addEventListener("error", () => {
    post({ type: "error" })
  })
}

self.onmessage = (e: MessageEvent) => {
  const command = e.data as WsWorkerCommand
  if (!command || command.channel !== WS_WORKER_RPC) return
  switch (command.type) {
    case "connect":
      url = command.url
      retryInterval = command.retryInterval
      openSocket()
      return
    case "send":
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(toArrayBuffer(encode(command.message)))
      }
      return
    case "disconnect":
      clearRetry()
      socket?.close()
      socket = undefined
      return
  }
}

export {}
