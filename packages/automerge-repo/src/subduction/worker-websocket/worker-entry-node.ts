/**
 * Node (`worker_threads`) entry point for the Subduction WebSocket proxy.
 *
 * Resolved automatically via the package's conditional exports: importing
 * `@automerge/automerge-repo/subduction-websocket-worker` in Node yields
 * this file; in the browser it yields the dedicated-worker entry.
 *
 * `WorkerWebSocketEndpoint` spawns this automatically (transferring a
 * `MessagePort` via `workerData.port`); DIY consumers may instead talk to
 * `parentPort` directly:
 *
 * ```ts
 * import { Worker } from "node:worker_threads"
 *
 * const worker = new Worker(
 *   new URL(
 *     import.meta.resolve("@automerge/automerge-repo/subduction-websocket-worker")
 *   )
 * )
 * // worker.postMessage / worker.on("message") speak the proxy protocol.
 * ```
 *
 * The socket itself is Node's native `WebSocket` (undici, Node ≥22), which
 * answers protocol pings on this worker's event loop, so keepalives
 * survive a blocked main thread.
 */

import { parentPort, workerData } from "node:worker_threads"
import { attachWebSocketHost } from "./host.js"
import type { WorkerPortLike } from "./protocol.js"

const port =
  (workerData as { port?: unknown } | null)?.port ?? parentPort ?? null

if (port === null) {
  throw new Error(
    "subduction-websocket-worker: no message port. Run this file inside a " +
      "worker_threads Worker (workerData.port or parentPort)."
  )
}

attachWebSocketHost(port as WorkerPortLike)
