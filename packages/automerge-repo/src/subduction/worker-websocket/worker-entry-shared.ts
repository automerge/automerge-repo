/// <reference lib="webworker" />
/**
 * SharedWorker entry point for the Subduction WebSocket proxy.
 *
 * Use this when the `Repo` itself runs inside a SharedWorker: Chrome and
 * Safari do not expose `Worker` there (crbug.com/40695450), so a tab must
 * spawn this SharedWorker and transfer a `MessagePort` to the repo worker,
 * which passes it to `WorkerWebSocketEndpoint` via the `worker` option.
 *
 * ```ts
 * // tab
 * const io = new SharedWorker(
 *   new URL(
 *     import.meta.resolve(
 *       "@automerge/automerge-repo/subduction-websocket-worker-shared"
 *     )
 *   ),
 *   { type: "module", name: "automerge-io" }
 * )
 * repoWorker.port.postMessage({ ... }, [io.port]) // donate the port
 * ```
 *
 * Every connecting port gets its own socket host (transports multiplex by
 * connection id, so one port can carry many sockets). Unhandled errors in
 * this worker are relayed to all connected ports on the
 * `am-worker-error` channel. To host WebSocket *and* IndexedDB proxying in
 * one SharedWorker, write your own entry that attaches both hosts — see
 * `attachWebSocketHost` and the storage package's `attachStorageHost`.
 */

import { createErrorRelay } from "../../worker-port/error-relay.js"
import { attachWebSocketHost } from "./host.js"
import type { WorkerPortLike } from "./protocol.js"

const relay = createErrorRelay()

const scope = globalThis as unknown as {
  onconnect: ((event: MessageEvent) => void) | null
}

scope.onconnect = (event: MessageEvent) => {
  const port = event.ports[0] as unknown as WorkerPortLike
  attachWebSocketHost(port)
  relay.addPort(port)
}

export {}
