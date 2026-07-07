/**
 * Main-thread half of the worker-based WebSocket transport: the Subduction
 * wasm instance stays on the main thread while the actual `WebSocket`
 * lives in a Worker, reached over a message port.
 *
 * ```
 * ┌─────────── main thread ───────────┐        ┌──── Worker ────┐
 * │ Repo → Subduction(wasm)           │        │                │
 * │   └─ WorkerWebSocketTransport ═postMessage═▶│  new WebSocket │═══▶ server
 * │         (bytes ⇄ port, transfer)  │◀═══════│  (owns socket) │
 * └───────────────────────────────────┘        └────────────────┘
 * ```
 *
 * Structurally identical to {@link WebSocketTransport} (same queue/waiter
 * FIFO — `postMessage` preserves per-port ordering, so the contract holds);
 * only the byte source differs.
 *
 * ## Receive acks
 *
 * Delivery from the worker is credit-windowed (see `protocol.ts`). This
 * side acks on *consumption* — when `recvBytes()` actually hands a frame to
 * the wasm — not on receipt, so the window bounds the entire main-side
 * backlog (event-loop tasks + `#messageQueue`). Acks are batched (half the
 * window) to keep port traffic negligible.
 */

import type { Transport } from "@automerge/automerge-subduction/slim"
import { makeLogger } from "../../Logger.js"
import {
  DEFAULT_WINDOW_FRAMES,
  WS_PROXY_CHANNEL,
  WorkerWebSocketError,
  isWsProxyMessage,
  type WorkerPortLike,
  type WsProxyRequest,
  type WsProxyResponse,
} from "./protocol.js"

const log = makeLogger("automerge-repo:subduction:worker-ws-transport")

/** Deadline for the worker to report `ws-open` before connect() rejects. */
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000

const randomConnId = (): string => {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID) return c.randomUUID()
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

export interface WorkerWebSocketConnectOptions {
  /** Max un-acked frames in flight from the worker. Default 128. */
  windowFrames?: number
  /** Max bytes buffered worker-side before fail-fast close. Default 128 MiB. */
  maxBufferedBytes?: number
  /** Reject `connect()` if the socket isn't open within this. Default 30 s. */
  connectTimeoutMs?: number
}

/**
 * Wraps a worker-hosted WebSocket connection as a subduction
 * {@link Transport}. Obtain instances via {@link WorkerWebSocketTransport.connect}.
 */
export class WorkerWebSocketTransport implements Transport {
  #port: WorkerPortLike
  #connId: string
  #messageQueue: Uint8Array[] = []
  #waiters: Array<(msg: Uint8Array) => void> = []
  #errorWaiters: Array<(err: Error) => void> = []
  #isClosed = false
  /** Why the connection ended; pending and future receivers get this. */
  #closeReason: Error | null = null
  #closedResolve!: () => void
  #closedPromise: Promise<void>
  #disconnectCallback: (() => void) | null = null
  /** Frames consumed since the last `ws-ack` was posted. */
  #unacked = 0
  /** Flush threshold: half the window keeps credit ahead of consumption. */
  #ackBatch: number

  private constructor(
    port: WorkerPortLike,
    connId: string,
    windowFrames: number
  ) {
    this.#port = port
    this.#connId = connId
    this.#ackBatch = Math.max(1, windowFrames >> 1)
    this.#closedPromise = new Promise(r => {
      this.#closedResolve = r
    })
    port.addEventListener("message", this.#handleMessage)
    port.start?.()
  }

  /**
   * Open a WebSocket in the worker behind `port` and return a transport
   * wrapping it. Resolves once the socket is open; rejects on socket
   * failure or after `connectTimeoutMs` (so a dead worker feeds the
   * reconnect loop instead of hanging it).
   *
   * Many transports may share one port (and therefore one worker); frames
   * are routed by connection id.
   */
  static connect(
    port: WorkerPortLike,
    url: string,
    {
      windowFrames = DEFAULT_WINDOW_FRAMES,
      maxBufferedBytes,
      connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    }: WorkerWebSocketConnectOptions = {}
  ): Promise<WorkerWebSocketTransport> {
    const connId = randomConnId()

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        port.removeEventListener("message", onMessage)
      }

      const timer = setTimeout(() => {
        cleanup()
        // Best-effort: if the worker is alive but slow, close the socket.
        WorkerWebSocketTransport.#post(port, {
          channel: WS_PROXY_CHANNEL,
          type: "ws-close",
          connId,
        })
        reject(
          new WorkerWebSocketError(
            `WebSocket connect timed out after ${connectTimeoutMs}ms. ` +
              "If this persists, the proxy worker may have failed to load " +
              "(e.g. the bundler did not emit the worker entry \u2014 see the " +
              "WorkerWebSocketEndpoint docs for bundler notes).",
            "connect-timeout"
          )
        )
      }, connectTimeoutMs)

      const onMessage = (event: MessageEvent) => {
        if (!isWsProxyMessage(event.data)) return
        const msg = event.data as WsProxyResponse
        if (msg.connId !== connId) return

        if (msg.type === "ws-open") {
          cleanup()
          resolve(new WorkerWebSocketTransport(port, connId, windowFrames))
        } else if (msg.type === "ws-error" || msg.type === "ws-closed") {
          cleanup()
          reject(
            new WorkerWebSocketError(
              msg.type === "ws-error"
                ? msg.message
                : "WebSocket connection failed",
              msg.type === "ws-error"
                ? (msg.code ?? "connect-failed")
                : "connect-failed"
            )
          )
        }
      }

      port.addEventListener("message", onMessage)
      port.start?.()
      WorkerWebSocketTransport.#post(port, {
        channel: WS_PROXY_CHANNEL,
        type: "ws-connect",
        connId,
        url,
        windowFrames,
        maxBufferedBytes,
      })
    })
  }

  static #post(
    port: WorkerPortLike,
    msg: WsProxyRequest,
    transfer?: Transferable[]
  ) {
    port.postMessage(msg, transfer)
  }

  #handleMessage = (event: MessageEvent) => {
    if (!isWsProxyMessage(event.data)) return
    const msg = event.data as WsProxyResponse
    if (msg.connId !== this.#connId) return

    switch (msg.type) {
      case "ws-bytes": {
        const bytes = new Uint8Array(msg.buf)
        const waiter = this.#waiters.shift()
        if (waiter) {
          this.#errorWaiters.shift()
          waiter(bytes)
          // Handed straight to the consumer — consumed now.
          this.#noteConsumed()
        } else {
          this.#messageQueue.push(bytes)
        }
        break
      }

      case "ws-closed":
        this.#fail(new WorkerWebSocketError("WebSocket closed", "closed"))
        break

      case "ws-error":
        log.warn("worker ws error:", msg.message)
        this.#fail(new WorkerWebSocketError(msg.message, msg.code ?? "closed"))
        break

      case "ws-open":
        // Already open; nothing to do.
        break
    }
  }

  /** Record a consumed frame; flush a batched ack at the threshold. */
  #noteConsumed() {
    this.#unacked++
    if (this.#unacked >= this.#ackBatch) this.#flushAcks()
  }

  #flushAcks() {
    if (this.#unacked === 0 || this.#isClosed) return
    const count = this.#unacked
    this.#unacked = 0
    WorkerWebSocketTransport.#post(this.#port, {
      channel: WS_PROXY_CHANNEL,
      type: "ws-ack",
      connId: this.#connId,
      count,
    })
  }

  /**
   * Mark closed, detach from the port, resolve `closed()`, and reject all
   * pending receivers. Detaching here (rather than only in teardown paths)
   * matters: remote close/error is the common way a connection ends, and a
   * leaked listener would accumulate per reconnect cycle — and on Node, a
   * listener-bearing MessagePort pins the event loop even when the worker
   * itself is unref'd.
   */
  #fail(err: Error) {
    this.#isClosed = true
    this.#closeReason ??= err
    this.#port.removeEventListener("message", this.#handleMessage)
    this.#closedResolve()
    for (const ew of this.#errorWaiters) ew(err)
    this.#errorWaiters = []
    this.#waiters = []
  }

  onDisconnect(callback: () => void): void {
    this.#disconnectCallback = callback
  }

  async sendBytes(bytes: Uint8Array): Promise<void> {
    if (this.#isClosed) throw this.#closeReason ?? new Error("WebSocket closed")
    // Copy before transferring: subduction may reuse the input buffer, and
    // a view into a larger buffer must not transfer unrelated bytes.
    const buf = bytes.slice().buffer
    WorkerWebSocketTransport.#post(
      this.#port,
      { channel: WS_PROXY_CHANNEL, type: "ws-send", connId: this.#connId, buf },
      [buf]
    )
  }

  recvBytes(): Promise<Uint8Array> {
    const queued = this.#messageQueue.shift()
    if (queued) {
      // Consumed from the local queue — ack so the worker's window refills.
      this.#noteConsumed()
      return Promise.resolve(queued)
    }
    if (this.#isClosed)
      return Promise.reject(this.#closeReason ?? new Error("WebSocket closed"))
    // Entering a wait: any frames consumed so far should refill the window
    // now, otherwise a quiet stretch could leave the worker short on credit.
    this.#flushAcks()
    return new Promise<Uint8Array>((resolve, reject) => {
      this.#waiters.push(resolve)
      this.#errorWaiters.push(reject)
    })
  }

  async disconnect(): Promise<void> {
    this.#teardown({ fireDisconnectCallback: false })
  }

  /**
   * Immediately fail the transport — for teardown paths where the worker
   * is about to be (or already is) terminated and would never deliver
   * `ws-closed`. Pending `recvBytes` calls reject; `closed()` resolves.
   * A best-effort `ws-close` is still posted so that a port which
   * *survives* (a supplied/shared worker) closes its socket instead of
   * buffering server pushes toward the byte cap.
   */
  abort(
    reason: Error = new WorkerWebSocketError(
      "WebSocket worker terminated",
      "worker-terminated"
    )
  ): void {
    if (this.#isClosed) return
    try {
      WorkerWebSocketTransport.#post(this.#port, {
        channel: WS_PROXY_CHANNEL,
        type: "ws-close",
        connId: this.#connId,
      })
    } catch {
      // The port may already be terminated/closed; failing locally is
      // all that matters then.
    }
    // Drop undelivered frames: teardown must not feed further wasm
    // dispatches (which can reach storage after the adapter closes).
    this.#messageQueue = []
    this.#fail(reason)
  }

  /** Resolves when the underlying WebSocket closes (for any reason). */
  closed(): Promise<void> {
    return this.#closedPromise
  }

  #teardown({
    fireDisconnectCallback,
  }: { fireDisconnectCallback?: boolean } = {}) {
    // Close the worker-side socket, then fail locally: pending receivers
    // must reject (the port listener detaches in `#fail`, so a `ws-closed`
    // reply could never settle them later).
    WorkerWebSocketTransport.#post(this.#port, {
      channel: WS_PROXY_CHANNEL,
      type: "ws-close",
      connId: this.#connId,
    })
    // Drop undelivered frames: a locally-initiated teardown means we are
    // shutting down — handing queued frames to the wasm now could trigger
    // dispatches against storage that is about to close.
    this.#messageQueue = []
    this.#fail(
      new WorkerWebSocketError("WebSocket disconnected", "disconnected")
    )
    if (fireDisconnectCallback && this.#disconnectCallback)
      this.#disconnectCallback()
  }
}
