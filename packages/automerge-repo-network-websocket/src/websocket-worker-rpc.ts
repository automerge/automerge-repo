/** RPC protocol between {@link WebSocketWorkerClientAdapter} and `websocket.worker.ts`. */
import type { FromClientMessage, FromServerMessage } from "./messages.js"

export const WS_WORKER_RPC = "automerge-repo-ws-worker-rpc" as const

/** host → worker */
export type WsWorkerCommandBody =
  | { type: "connect"; url: string; retryInterval: number }
  | { type: "send"; message: FromClientMessage }
  | { type: "disconnect" }

export type WsWorkerCommand = WsWorkerCommandBody & {
  channel: typeof WS_WORKER_RPC
}

/** worker → host */
export type WsWorkerEventBody =
  | { type: "open" }
  | { type: "message"; message: FromServerMessage }
  | { type: "close" }
  | { type: "error" }

export type WsWorkerEvent = WsWorkerEventBody & {
  channel: typeof WS_WORKER_RPC
}
