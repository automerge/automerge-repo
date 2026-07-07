/**
 * Dedicated-worker entry point for the Subduction WebSocket proxy.
 *
 * `WorkerWebSocketEndpoint` spawns this automatically; you only need it
 * when supplying your own worker. Resolve the specifier in your own
 * source (bare specifiers inside `new URL(...)` only work under
 * webpack 5):
 *
 * ```ts
 * const worker = new Worker(
 *   new URL(
 *     import.meta.resolve("@automerge/automerge-repo/subduction-websocket-worker")
 *   ),
 *   { type: "module" }
 * )
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

import { attachWebSocketHost } from "./host.js"
import type { WorkerPortLike } from "./protocol.js"

attachWebSocketHost(globalThis as unknown as WorkerPortLike)
