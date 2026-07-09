/// <reference lib="webworker" />
/**
 * SharedWorker entry point for {@link IndexedDBWorkerStorageAdapter}.
 *
 * Use this when the `Repo` runs inside a SharedWorker: Chrome and Safari
 * do not expose `Worker` there (crbug.com/40695450), so a tab spawns this
 * SharedWorker and transfers a `MessagePort` to the repo worker, which
 * passes it to the adapter's `worker` option.
 *
 * All connecting ports share one dispatcher, so adapters on different
 * ports addressing the same database observe a single set of IndexedDB
 * connections. Unhandled errors in this worker are relayed to all
 * connected ports on the `am-worker-error` channel.
 */
import { createErrorRelay } from "@automerge/automerge-repo/worker-port"
import type { WorkerPortLike } from "@automerge/automerge-repo/slim"
import { makeStorageRpcDispatcher } from "./worker-handler.js"
import { attachStorageHost } from "./worker-host.js"

const dispatch = makeStorageRpcDispatcher()
const relay = createErrorRelay()

const scope = globalThis as unknown as {
  onconnect: ((event: MessageEvent) => void) | null
}

scope.onconnect = (event: MessageEvent) => {
  const port = event.ports[0] as unknown as WorkerPortLike
  attachStorageHost(port, dispatch)
  relay.addPort(port)
}

export {}
