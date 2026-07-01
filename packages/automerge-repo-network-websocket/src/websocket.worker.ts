/// <reference lib="webworker" />
/** Worker entrypoint for {@link WebSocketWorkerClientAdapter}. */
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
