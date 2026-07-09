/// <reference lib="webworker" />
/**
 * Combined io SharedWorker entry: IndexedDB storage RPC **and** the
 * Subduction WebSocket proxy on every connecting port (the channel tags
 * keep the two protocols disjoint).
 *
 * This is the entry to donate when one provider feeds both the storage
 * adapter and the sync endpoint from a single port — the topology shown
 * in `worker-port/provide.ts`'s module docs:
 *
 * ```ts
 * // repo SharedWorker
 * const io = makePortProvider()
 * new Repo({
 *   storage: new IndexedDBWorkerStorageAdapter("db", "docs", io.source),
 *   subductionWebsocketEndpoints: [
 *     new WorkerWebSocketEndpoint(url, { worker: io.source }),
 *   ],
 * })
 * ```
 *
 * The single-purpose entries (`worker-shared` here, and automerge-repo's
 * `subduction-websocket-worker-shared`) serve one protocol each; donating
 * one of those into a both-consumers provider stalls the other consumer.
 *
 * All connecting ports share one storage dispatcher (a single set of
 * IndexedDB connections). Unhandled errors are relayed on
 * `am-worker-error`; event-loop stalls ≥250ms on `am-worker-stats`.
 */
import {
  createErrorRelay,
  startDriftProbe,
} from "@automerge/automerge-repo/worker-port"
import {
  attachWebSocketHost,
  type WorkerPortLike,
} from "@automerge/automerge-repo/slim"
import { makeStorageRpcDispatcher } from "./worker-handler.js"
import { attachStorageHost } from "./worker-host.js"

const dispatch = makeStorageRpcDispatcher()
const relay = createErrorRelay()
startDriftProbe(sample => relay.post(sample))

const scope = globalThis as unknown as {
  onconnect: ((event: MessageEvent) => void) | null
}

scope.onconnect = (event: MessageEvent) => {
  const port = event.ports[0] as unknown as WorkerPortLike
  attachStorageHost(port, dispatch)
  attachWebSocketHost(port)
  relay.addPort(port)
}

export {}
