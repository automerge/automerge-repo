/// <reference lib="webworker" />
/**
 * SharedWorker entry point for the Subduction WebSocket proxy.
 *
 * Use this when the `Repo` itself runs inside a SharedWorker: Chrome and
 * Safari do not expose `Worker` there (crbug.com/40695450), so a tab must
 * spawn this SharedWorker and transfer a `MessagePort` to the repo worker,
 * which passes it to `WorkerWebSocketEndpoint` via the `worker` option.
 *
 * Spawn it from a file in *your own source* so every bundler emits the
 * chunk (`import.meta.resolve` of a bare specifier inside
 * `new SharedWorker(...)` is not statically analyzable — Vite won't
 * rewrite it). Create `ws-worker.ts` containing exactly
 * `import "@automerge/automerge-repo/subduction-websocket-worker-shared"`,
 * then donate via `donatePort` (a raw postMessage would be refused: the
 * provisioning protocol is version-tagged):
 *
 * ```ts
 * // tab
 * import { donatePort } from "@automerge/automerge-repo/worker-port"
 *
 * donatePort(repoWorker.port, () => {
 *   const io = new SharedWorker(new URL("./ws-worker.ts", import.meta.url), {
 *     type: "module",
 *     name: "automerge-io",
 *   })
 *   return io.port
 * })
 * ```
 *
 * Every connecting port gets its own socket host (transports multiplex by
 * connection id, so one port can carry many sockets). Unhandled errors in
 * this worker are relayed to all connected ports on the
 * `am-worker-error` channel.
 *
 * This entry serves the WebSocket proxy **only**. To feed one provider
 * into both the sync endpoint and the storage adapter, donate the
 * combined entry
 * `@automerge/automerge-repo-storage-indexeddb/worker-io-shared` instead
 * (or write your own entry attaching both hosts — see
 * `attachWebSocketHost` and the storage package's `attachStorageHost`).
 */

import { startDriftProbe } from "../../worker-port/drift-probe.js"
import { createErrorRelay } from "../../worker-port/error-relay.js"
import { attachWebSocketHost } from "./host.js"
import type { WorkerPortLike } from "./protocol.js"

const relay = createErrorRelay()
// Health probe: reports event-loop stalls ≥250ms to every connected port
// on `am-worker-stats` (see `isWorkerStatsMessage`). Silence = healthy.
startDriftProbe(sample => relay.post(sample))

const scope = globalThis as unknown as {
  onconnect: ((event: MessageEvent) => void) | null
}

scope.onconnect = (event: MessageEvent) => {
  const port = event.ports[0] as unknown as WorkerPortLike
  attachWebSocketHost(port)
  relay.addPort(port)
}

export {}
