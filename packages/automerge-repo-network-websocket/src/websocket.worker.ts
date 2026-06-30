/// <reference lib="webworker" />
/**
 * Worker entrypoint for {@link WebSocketWorkerClientAdapter}. Owns one
 * WebSocket, draining it continuously and doing CBOR encode/decode off the host
 * thread, so socket I/O and keepalives keep flowing even while the host is busy
 * with synchronous CRDT/Wasm work. Reconnect (with the host-provided retry
 * interval) lives here too.
 *
 * The logic lives in {@link makeWebSocketWorkerHandler} (`websocket-worker-handler.ts`)
 * so it can be tested without a browser. Spawned by the adapter via
 * `new Worker(new URL("./websocket.worker.js", import.meta.url), { type: "module" })`.
 */
import {
  makeWebSocketWorkerHandler,
  type WsSocketLike,
} from "./websocket-worker-handler.js"
import {
  WS_WORKER_RPC,
  type WsWorkerCommand,
  type WsWorkerEventBody,
} from "./websocket-worker-rpc.js"

const handle = makeWebSocketWorkerHandler({
  createSocket: (url: string) => new WebSocket(url) as unknown as WsSocketLike,
  post: (event: WsWorkerEventBody) =>
    (self as unknown as Worker).postMessage({
      channel: WS_WORKER_RPC,
      ...event,
    }),
})

self.onmessage = (e: MessageEvent) => handle(e.data as WsWorkerCommand)

export {}
