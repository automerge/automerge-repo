/**
 * Dedicated-worker entry point for the Subduction WebSocket proxy.
 *
 * `WorkerWebSocketEndpoint` spawns this automatically; you only need it
 * when supplying your own worker. Spawn it from a file in your own
 * source so every bundler emits the chunk (`import.meta.resolve` of a
 * bare specifier inside `new Worker(...)` is not statically analyzable):
 * create `ws-worker.ts` containing exactly
 * `import "@automerge/automerge-repo/subduction-websocket-worker"`, then:
 *
 * ```ts
 * const worker = new Worker(new URL("./ws-worker.ts", import.meta.url), {
 *   type: "module",
 * })
 * const repo = new Repo({
 *   subductionWebsocketEndpoints: [
 *     new WorkerWebSocketEndpoint("wss://sync.example.com", { worker }),
 *   ],
 * })
 * ```
 *
 * This entry attaches to the dedicated-worker global scope, so it cannot
 * back a `SharedWorker` directly (connections arrive as per-client ports
 * there). For a shared worker, write a small script that calls
 * `attachWebSocketHost(port)` for each `onconnect` port and hand each
 * tab's endpoint its port.
 */

import { startDriftProbe } from "../../worker-port/drift-probe.js"
import { attachWebSocketHost } from "./host.js"
import type { WorkerPortLike } from "./protocol.js"

const port = globalThis as unknown as WorkerPortLike
attachWebSocketHost(port)
// Health probe: reports event-loop stalls ≥250ms on `am-worker-stats`
// (see `isWorkerStatsMessage`). A healthy proxy stays silent.
startDriftProbe(sample => port.postMessage(sample))
