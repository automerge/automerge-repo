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
import type { WorkerPortLike } from "./worker-websocket/protocol.js"
import { WebSocketTransport } from "./websocket-transport.js"
import { WorkerWebSocketTransport } from "./worker-websocket/transport.js"

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
 * A sync-server endpoint whose WebSocket lives in a Worker, keeping socket
 * I/O off the thread running the Repo. Bytes are relayed over `postMessage`
 * with transferred buffers.
 *
 * By default each endpoint lazily spawns a dedicated `Worker` from the
 * shipped proxy entry module and terminates it on shutdown. Pass `worker`
 * to control where the socket lives instead — a `Worker`, a `SharedWorker`'s
 * `port`, or any `MessagePort` running the proxy host from
 * `@automerge/automerge-repo/subduction-websocket-worker`. A supplied port
 * is never terminated (it may be shared: transports multiplex by
 * connection id, so many endpoints can pass the same one).
 *
 * The receive path is credit-windowed (see `worker-websocket/protocol.ts`):
 * a busy main thread never stalls socket reads — keepalive pongs keep
 * flowing and the server never blocks on a closed TCP window — while the
 * backlog buffers in the worker, bounded by `maxBufferedBytes`.
 */
export interface WorkerWebSocketEndpointOptions {
  /** A dedicated `Worker`, a `SharedWorker`'s `port`, or any `MessagePort`. */
  worker?: WorkerPortLike
  /** Max un-acked frames in flight to the main thread. Default 128. */
  windowFrames?: number
  /**
   * Max bytes buffered in the worker while the main thread lags. Exceeding
   * it closes the socket with a distinct error (reconnect + resync
   * recover). Default 128 MiB — sync bursts can be large.
   */
  maxBufferedBytes?: number
  /** Reject a connection attempt after this long. Default 30 s. */
  connectTimeoutMs?: number
}

export class WorkerWebSocketEndpoint implements WebSocketEndpointInterface {
  #port: WorkerPortLike | null
  #ownsWorker = false
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
    // Fail live transports BEFORE terminating the worker: a hard
    // `terminate()` kills the socket's `close` handler, so `ws-closed`
    // would never arrive and pending `recvBytes` calls would hang forever.
    for (const transport of this.#transports) {
      transport.abort(new Error("WorkerWebSocketEndpoint shut down"))
    }
    this.#transports.clear()

    if (this.#ownsWorker && this.#port) {
      ;(this.#port as Worker).terminate()
    }
    this.#port = null
    this.#ownsWorker = false
  }

  #resolvePort(): WorkerPortLike {
    if (this.#port) return this.#port

    if (typeof Worker === "undefined") {
      throw new Error(
        "WorkerWebSocketEndpoint requires the Worker API. In this " +
          "environment, use WebSocketEndpoint (in-thread socket) or pass " +
          "an explicit worker port."
      )
    }

    this.#port = new Worker(
      new URL("./worker-websocket/worker-entry.js", import.meta.url),
      { type: "module" }
    )
    this.#ownsWorker = true
    return this.#port
  }
}
