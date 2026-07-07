/**
 * WebSocket endpoint types for the Subduction sync engine, mirroring the
 * non-subduction network adapter pattern (`WebSocketClientAdapter`, ...):
 * separate classes per socket location, instantiated by the consumer and
 * passed to `Repo` via `subductionWebsocketEndpoints`.
 *
 * ```ts
 * new Repo({
 *   subductionWebsocketEndpoints: [
 *     "wss://a.example.com",                              // in-thread
 *     new WebSocketEndpoint("wss://b.example.com"),       // in-thread, explicit
 *     new WorkerWebSocketEndpoint("wss://c.example.com"), // socket in a Worker
 *   ],
 * })
 * ```
 *
 * An endpoint owns *where* its socket lives and how to (re)create it; the
 * shared reconnect/backoff loop in `SubductionConnections` owns *when*.
 */

import type { Transport } from "@automerge/automerge-subduction/slim"
import {
  WorkerWebSocketError,
  type WorkerPortLike,
} from "./worker-websocket/protocol.js"
import { WebSocketTransport } from "./websocket-transport.js"
import {
  WorkerWebSocketTransport,
  type WorkerWebSocketConnectOptions,
} from "./worker-websocket/transport.js"

/** A subduction transport that can also report when it has closed. */
export type ManagedTransport = Transport & { closed(): Promise<void> }

/**
 * A WebSocket endpoint the subduction reconnect loop can (re)establish.
 * Implement this to route sockets anywhere; the two stock implementations
 * are {@link WebSocketEndpoint} (in-thread) and
 * {@link WorkerWebSocketEndpoint} (socket in a Worker).
 */
export interface WebSocketEndpointInterface {
  readonly url: string

  /** Open a fresh connection. Called by the reconnect loop, possibly many times. */
  connect(): Promise<ManagedTransport>

  /**
   * Optional teardown hook, called once after the owning source has fully
   * shut down (all transports disconnected). Release anything the endpoint
   * owns — e.g. terminate an auto-spawned worker.
   */
  shutdown?(): void
}

/** A sync-server endpoint whose WebSocket runs on the current thread. */
export class WebSocketEndpoint implements WebSocketEndpointInterface {
  constructor(readonly url: string) {}

  connect(): Promise<ManagedTransport> {
    return WebSocketTransport.connect(this.url)
  }
}

/**
 * Options for {@link WorkerWebSocketEndpoint}. Note the byte cap is
 * per connection: N endpoints can buffer N × `maxBufferedBytes`.
 */
export interface WorkerWebSocketEndpointOptions extends WorkerWebSocketConnectOptions {
  /**
   * Where the socket lives: a browser dedicated `Worker`, a
   * `SharedWorker`'s `port`, or any `MessagePort` whose far side runs the
   * proxy host. In Node, pass a `MessageChannel` port wired to the worker
   * via `workerData` (a `worker_threads.Worker` itself is an EventEmitter
   * and does not satisfy {@link WorkerPortLike}); the auto-spawn path does
   * this for you.
   */
  worker?: WorkerPortLike
}

/** Structural view of `node:worker_threads` (avoids a @types/node dependency). */
interface NodeWorkerThreads {
  MessageChannel: new () => { port1: WorkerPortLike; port2: unknown }
  Worker: new (
    url: URL,
    opts: { workerData: unknown; transferList: unknown[] }
  ) => { terminate(): Promise<number> | void; unref(): void }
}

/**
 * `node:worker_threads`, when running under Node ≥22.3; else `null`.
 * Checked before the browser `Worker` global: DOM-emulating test
 * environments (happy-dom, jsdom) may define a fake `Worker` that can't
 * actually run our entry module.
 *
 * @internal Exported for tests only.
 */
export const nodeWorkerThreads = (): NodeWorkerThreads | null => {
  const proc = (
    globalThis as {
      process?: {
        versions?: { node?: string }
        getBuiltinModule?: (id: string) => unknown
      }
    }
  ).process
  if (!proc?.versions?.node || typeof proc.getBuiltinModule !== "function")
    return null
  try {
    return (
      (proc.getBuiltinModule("node:worker_threads") as NodeWorkerThreads) ??
      null
    )
  } catch {
    // A partial `process` shim that throws here means "not really Node".
    return null
  }
}

/**
 * A sync-server endpoint whose WebSocket lives in a Worker, keeping socket
 * I/O off the thread running the Repo. Bytes are relayed over `postMessage`
 * with transferred buffers.
 *
 * By default each endpoint lazily spawns a dedicated worker from the
 * shipped proxy entry module (browser `Worker` or Node `worker_threads`,
 * detected at runtime) and terminates it on shutdown. Pass `worker` to
 * control where the socket lives instead; a supplied port is never
 * terminated and may be shared — transports multiplex by connection id,
 * so many endpoints can pass the same one.
 *
 * The receive path is credit-windowed (see `worker-websocket/protocol.ts`):
 * a busy main thread never stalls socket reads, so keepalive pongs keep
 * flowing and the server's TCP window stays open. The backlog buffers in
 * the worker, bounded by `maxBufferedBytes`.
 *
 * Bundler notes for the auto-spawn path (`new Worker(new URL(...))` inside
 * this library): webpack 5 and workspace-linked Vite handle it; Vite
 * consumers installing from npm must add
 * `optimizeDeps: { exclude: ["@automerge/automerge-repo"] }` (dep
 * pre-bundling breaks `import.meta.url`-relative worker files); plain
 * Rollup and single-file Node bundles do not ship the entry file. In any
 * of those environments, spawn the worker yourself from
 * `@automerge/automerge-repo/subduction-websocket-worker` in your own
 * source and pass it via `worker` — that pattern every bundler handles.
 */
export class WorkerWebSocketEndpoint implements WebSocketEndpointInterface {
  #port: WorkerPortLike | null
  /** Tears down whatever `#resolvePort` spawned (browser Worker or node thread). */
  #terminateOwned: (() => void) | null = null
  #options: Omit<WorkerWebSocketEndpointOptions, "worker">
  /** Live transports, so `shutdown()` can fail them before terminate(). */
  #transports = new Set<WorkerWebSocketTransport>()

  constructor(
    readonly url: string,
    { worker, ...options }: WorkerWebSocketEndpointOptions = {}
  ) {
    this.#port = worker ?? null
    this.#options = options
  }

  async connect(): Promise<ManagedTransport> {
    const transport = await WorkerWebSocketTransport.connect(
      this.#resolvePort(),
      this.url,
      this.#options
    )
    this.#transports.add(transport)
    // Drop the registry entry once the connection is over, however it ends.
    void transport.closed().then(() => this.#transports.delete(transport))
    return transport
  }

  shutdown(): void {
    // Fail live transports before terminating the worker: a hard
    // `terminate()` kills the socket's `close` handler, so `ws-closed`
    // would never arrive and pending `recvBytes` calls would hang forever.
    // (`abort` also posts a best-effort `ws-close`, which is what closes
    // the socket when the port is supplied/shared and survives shutdown.)
    for (const transport of this.#transports) {
      transport.abort(
        new WorkerWebSocketError(
          "WorkerWebSocketEndpoint shut down",
          "worker-terminated"
        )
      )
    }
    this.#transports.clear()

    // Only an auto-spawned worker is torn down; a supplied port is shared
    // infrastructure and stays usable (including by this endpoint, should
    // `connect()` be called again).
    if (this.#terminateOwned) {
      this.#terminateOwned()
      this.#terminateOwned = null
      this.#port = null
    }
  }

  #resolvePort(): WorkerPortLike {
    if (this.#port) return this.#port

    // Node first: DOM-emulating test environments may expose a fake
    // `Worker` global, but a real Node runtime always has worker_threads.
    const wt = nodeWorkerThreads()
    if (wt) {
      const channel = new wt.MessageChannel()
      const worker = new wt.Worker(
        new URL("./worker-websocket/worker-entry-node.js", import.meta.url),
        { workerData: { port: channel.port2 }, transferList: [channel.port2] }
      )
      // Never pin process exit on the proxy thread.
      worker.unref()
      this.#port = channel.port1
      this.#terminateOwned = () => void worker.terminate()
      return this.#port
    }

    if (typeof Worker !== "undefined") {
      const worker = new Worker(
        new URL("./worker-websocket/worker-entry.js", import.meta.url),
        { type: "module" }
      )
      this.#port = worker
      this.#terminateOwned = () => worker.terminate()
      return this.#port
    }

    throw new Error(
      "WorkerWebSocketEndpoint requires worker_threads (Node) or the " +
        "Worker API (browser). In this environment, use WebSocketEndpoint " +
        "(in-thread socket) or pass an explicit worker port."
    )
  }
}
