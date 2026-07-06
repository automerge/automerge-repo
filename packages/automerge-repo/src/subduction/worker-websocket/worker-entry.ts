/**
 * Dedicated-worker entry point for the Subduction WebSocket proxy.
 *
 * `WorkerWebSocketEndpoint` spawns this automatically; you only need it
 * when supplying your own worker/port (e.g. a `SharedWorker` shared
 * across tabs):
 *
 * ```ts
 * const worker = new Worker(
 *   new URL("@automerge/automerge-repo/subduction-websocket-worker", import.meta.url),
 *   { type: "module" }
 * )
 * const repo = new Repo({
 *   subductionWebsocketEndpoints: [
 *     new WorkerWebSocketEndpoint("wss://sync.example.com", { worker }),
 *   ],
 * })
 * ```
 */

import { attachWebSocketHost } from "./host.js"
import type { WorkerPortLike } from "./protocol.js"

attachWebSocketHost(globalThis as unknown as WorkerPortLike)
