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
import { makeLogger } from "../Logger.js"
import {
  isWorkerErrorMessage,
  isWorkerStatsMessage,
} from "../worker-port/protocol.js"
import {
  WorkerWebSocketError,
  type WorkerPortLike,
  type WorkerPortSource,
} from "./worker-websocket/protocol.js"

const log = makeLogger("automerge-repo:subduction:worker-ws-endpoint")

/**
 * Auto-spawned workers report health signals (drift stats, relayed
 * errors) on a port only this endpoint holds — without this, those
 * messages would go nowhere. Provided/shared ports are observable by
 * whoever owns them, so this is only wired for owned workers.
 */
const logHealthSignals = (port: WorkerPortLike): void => {
  port.addEventListener("message", (event: MessageEvent) => {
    const msg = event.data
    if (isWorkerStatsMessage(msg)) {
      log.warn(`proxy worker event loop stalled ${msg.driftMs}ms`)
    } else if (isWorkerErrorMessage(msg)) {
      log.warn(`proxy worker ${msg.kind}: ${msg.message}`, msg.stack ?? "")
    }
  })
}
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
   *
   * May also be a **provider function** returning (a promise of) a port.
   * The endpoint calls it lazily on first `connect()`, caches the result,
   * and — when the port's `close` event fires (far side crashed or shut
   * down) — discards the cache so the next reconnect attempt re-invokes
   * the provider for a fresh port. Use this when the port is donated
   * asynchronously by another context, e.g. a tab transferring a
   * `MessagePort` into the SharedWorker hosting the `Repo` (Chrome cannot
   * spawn workers from a SharedWorker).
   */
  worker?: WorkerPortSource
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
 * the worker, bounded by `maxBufferedBytes`. Tune per endpoint via
 * `windowFrames` (max un-acked frames delivered to the consumer thread —
 * lower it to cap how much decode work can queue there at once) and
 * `maxBufferedBytes` (worker-side backlog cap before a fail-fast
 * `backlog-exceeded` close; reconnect + resync recover).
 *
 * Health signals: the shipped browser proxy entries run a drift probe
 * that reports event-loop stalls ≥250ms on the `am-worker-stats` channel
 * (`isWorkerStatsMessage`), and the SharedWorker entries relay unhandled
 * worker errors on `am-worker-error` (`isWorkerErrorMessage`). In
 * auto-spawn mode this endpoint logs both via the
 * `automerge-repo:subduction:worker-ws-endpoint` debug logger (the port
 * is private, so nothing else could observe them); when you supply the
 * port — including via a provider — wire the listeners into your own
 * logging, since SharedWorker consoles are otherwise only visible in
 * `chrome://inspect/#workers`. All proxy messages are version-tagged;
 * build skew (a stale cached worker chunk after a deploy) fails loudly
 * with a `protocol-mismatch` error instead of misbehaving.
 *
 * Plain URL strings in `subductionWebsocketEndpoints` remain fully
 * supported (in-thread `WebSocketEndpoint`); this class is an opt-in.
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
 *
 * When the `Repo` itself runs inside a **SharedWorker**, auto-spawn cannot
 * work at all: Chrome and Safari don't expose `Worker` there
 * (crbug.com/40695450). Have a tab spawn the proxy — e.g. the shipped
 * SharedWorker entry `@automerge/automerge-repo/subduction-websocket-worker-shared`
 * — and donate a `MessagePort` into the repo worker; pass a provider
 * function via `worker` so late-arriving and replacement ports work. See
 * `makePortProvider` / `donatePort` in `@automerge/automerge-repo/worker-port`.
 */
export class WorkerWebSocketEndpoint implements WebSocketEndpointInterface {
  #port: WorkerPortLike | null
  /** Re-invoked for a fresh port after the cached one closes. */
  #portSource: (() => WorkerPortLike | Promise<WorkerPortLike>) | null
  /**
   * Single-flight guard for provider fetches: concurrent `connect()` calls
   * while no port is cached must share one `#portSource()` invocation, or
   * each would trigger its own donation (and leak the extras). Cleared
   * when the fetch settles.
   */
  #fetchingPort: Promise<WorkerPortLike> | null = null
  /** Tears down whatever `#resolvePort` spawned (browser Worker or node thread). */
  #terminateOwned: (() => void) | null = null
  #options: Omit<WorkerWebSocketEndpointOptions, "worker">
  /** Live transports, so `shutdown()` can fail them before terminate(). */
  #transports = new Set<WorkerWebSocketTransport>()

  constructor(
    readonly url: string,
    { worker, ...options }: WorkerWebSocketEndpointOptions = {}
  ) {
    this.#portSource = typeof worker === "function" ? worker : null
    this.#port = typeof worker === "function" ? null : (worker ?? null)
    this.#options = options
  }

  async connect(): Promise<ManagedTransport> {
    const port = await this.#resolvePort()
    let transport: WorkerWebSocketTransport
    try {
      transport = await WorkerWebSocketTransport.connect(
        port,
        this.url,
        this.#options
      )
    } catch (error) {
      // Timeout/mismatch on a provider port: evict it so the next
      // reconnect re-invokes the provider. The `close` event alone can't
      // be trusted here — it may have fired before our listener attached,
      // and browsers below the close floor never fire it.
      if (
        this.#portSource &&
        error instanceof WorkerWebSocketError &&
        (error.code === "connect-timeout" || error.code === "protocol-mismatch")
      ) {
        this.#unwatchProvidedPort(port)
      }
      throw error
    }
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

  async #resolvePort(): Promise<WorkerPortLike> {
    if (this.#port) return this.#port

    if (this.#portSource) {
      const source = this.#portSource
      this.#fetchingPort ??= Promise.resolve()
        .then(() => source())
        .then(port => {
          this.#watchProvidedPort(port)
          return port
        })
        .finally(() => {
          this.#fetchingPort = null
        })
      return this.#fetchingPort
    }

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
      logHealthSignals(this.#port)
      return this.#port
    }

    if (typeof Worker !== "undefined") {
      const worker = new Worker(
        new URL("./worker-websocket/worker-entry.js", import.meta.url),
        { type: "module" }
      )
      this.#port = worker
      this.#terminateOwned = () => worker.terminate()
      logHealthSignals(this.#port)
      return this.#port
    }

    throw new Error(
      "WorkerWebSocketEndpoint requires worker_threads (Node) or the " +
        "Worker API (browser). In this environment, use WebSocketEndpoint " +
        "(in-thread socket) or pass an explicit worker port. Note that " +
        "Chrome and Safari do not expose Worker inside a SharedWorker " +
        "(crbug.com/40695450): spawn the proxy worker from a tab and " +
        "transfer a MessagePort in via the `worker` option (a provider " +
        "function is supported for late-arriving ports)."
    )
  }

  /**
   * Cache a provider-obtained port until its far side dies, then drop the
   * cache so the reconnect loop's next `connect()` fetches a replacement.
   * Provided ports are shared infrastructure and are never terminated.
   */
  #watchProvidedPort(port: WorkerPortLike) {
    if (this.#port === port) return // provider re-supplied the live port
    this.#unwatch?.() // replace any watch on a superseded port
    this.#port = port
    const onClose = () => this.#unwatchProvidedPort(port)
    this.#unwatch = () => port.removeEventListener("close", onClose)
    port.addEventListener("close", onClose)
  }

  /** Removes the current provided port's close listener, when any. */
  #unwatch: (() => void) | null = null

  /** Forget a provided port so the next connect re-invokes the provider. */
  #unwatchProvidedPort(port: WorkerPortLike) {
    if (this.#port !== port) return
    this.#unwatch?.()
    this.#unwatch = null
    this.#port = null
  }
}
