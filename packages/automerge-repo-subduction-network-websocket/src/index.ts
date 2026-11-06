import { BackendError } from "@automerge/automerge-repo/sedimentree"
import type {
  SubductionConnect,
  SubductionNetworkAdapterInterface,
} from "@automerge/automerge-repo-subduction"
import { openTransport } from "./websocket.js"

export type SubductionWebSocketServer =
  | string
  | URL
  | { url: string | URL; serviceName?: string }
export type WebSocketConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected"
  | "closed"

export interface WebSocketSubductionNetworkAdapterOptions {
  /** `stableMs`: how long a connection must stay up before backoff resets. Default: 5s. */
  retry?: false | { initialMs?: number; maxMs?: number; stableMs?: number }
  /** Deadline for socket opening, authentication and backend onboarding. Default: 10s. */
  connectTimeoutMilliseconds?: number
}

interface Pending {
  resolve(): void
  reject(cause: unknown): void
}

/** Connects a Subduction backend to one WebSocket server, reconnecting with
 * backoff. The backend starts and stops it; the handshake is signed with the
 * backend's signer. */
export class WebSocketSubductionNetworkAdapter implements SubductionNetworkAdapterInterface {
  readonly url: string
  readonly #serviceName: string
  readonly #retry: boolean
  readonly #initialMs: number
  readonly #maxMs: number
  readonly #timeoutMs: number
  readonly #stableMs: number
  #connect?: SubductionConnect
  #currentStatus: WebSocketConnectionStatus = "idle"
  #currentError: unknown
  #delay: number
  #timer: ReturnType<typeof setTimeout> | undefined
  #controller: AbortController | undefined
  #running: Promise<void> | undefined
  #stopping: Promise<void> | undefined
  #immediate = false
  #notification = 0
  #first: Pending | undefined
  readonly #listeners = new Set<(status: WebSocketConnectionStatus) => void>()
  readonly #waiters = new Set<Pending>()

  constructor(
    server: SubductionWebSocketServer,
    options: WebSocketSubductionNetworkAdapterOptions = {}
  ) {
    const config =
      typeof server === "string" || server instanceof URL
        ? { url: server }
        : server
    const url = new URL(config.url)
    if (url.protocol !== "ws:" && url.protocol !== "wss:")
      throw new TypeError("Subduction servers must use ws: or wss:")
    this.url = url.href
    this.#serviceName = config.serviceName ?? url.host
    this.#retry = options.retry !== false
    this.#initialMs = options.retry ? (options.retry.initialMs ?? 500) : 500
    this.#maxMs = options.retry ? (options.retry.maxMs ?? 30_000) : 30_000
    this.#timeoutMs = options.connectTimeoutMilliseconds ?? 10_000
    this.#stableMs = options.retry ? (options.retry.stableMs ?? 5_000) : 5_000
    for (const value of [
      this.#initialMs,
      this.#maxMs,
      this.#timeoutMs,
      this.#stableMs,
    ])
      if (!Number.isSafeInteger(value) || value <= 0 || value > 0x7fffffff)
        throw new TypeError(
          "Connection delays must be positive timer-safe integers"
        )
    if (this.#maxMs < this.#initialMs)
      throw new TypeError("maxMs must be at least initialMs")
    this.#delay = this.#initialMs
  }

  get status(): WebSocketConnectionStatus {
    return this.#currentStatus
  }

  get error(): unknown {
    return this.#currentError
  }

  /** Called immediately, then on state changes. */
  subscribe(callback: (status: WebSocketConnectionStatus) => void): () => void {
    if (this.#currentStatus !== "closed") this.#listeners.add(callback)
    callback(this.#currentStatus)
    return () => {
      this.#listeners.delete(callback)
    }
  }

  /** Wait for a connection, across automatic retries. Rejects on close. */
  connected(): Promise<void> {
    if (this.#currentStatus === "connected") return Promise.resolve()
    if (
      this.#currentStatus === "closed" ||
      (this.#currentStatus === "disconnected" && !this.#retry)
    )
      return Promise.reject(
        this.#currentError ?? new Error("Subduction connection closed")
      )
    return new Promise((resolve, reject) =>
      this.#waiters.add({ resolve, reject })
    )
  }

  /** Cancel the current attempt/connection and retry immediately. */
  reconnect(): void {
    if (this.#currentStatus === "closed" || !this.#connect) return
    this.#attempt()
  }

  start(connect: SubductionConnect): Promise<void> {
    if (this.#connect)
      return Promise.reject(new Error("Adapter has already been started"))
    if (this.#currentStatus === "closed")
      return Promise.reject(new Error("Subduction connection closed"))
    this.#connect = connect
    const first = new Promise<void>((resolve, reject) => {
      this.#first = { resolve, reject }
    })
    this.#attempt()
    return first
  }

  stop(): Promise<void> {
    if (this.#stopping) return this.#stopping
    this.#stopping = Promise.resolve().then(async () => {
      await this.#running
    })
    this.#clearRetry()
    this.#update("closed")
    this.#listeners.clear()
    this.#controller?.abort(new Error("Subduction connection closed"))
    return this.#stopping
  }

  #isClosed(): boolean {
    return this.#currentStatus === "closed"
  }

  #update(next: WebSocketConnectionStatus, cause?: unknown): void {
    if (this.#currentStatus === next && this.#currentError === cause) return
    const revision = ++this.#notification
    this.#currentStatus = next
    this.#currentError = cause
    const closed = cause ?? new Error("Subduction connection closed")
    if (
      next === "connected" ||
      next === "closed" ||
      (next === "disconnected" && !this.#retry && !this.#immediate)
    ) {
      for (const waiter of this.#waiters)
        if (next === "connected") waiter.resolve()
        else waiter.reject(closed)
      this.#waiters.clear()
    }
    const first = this.#first
    if (first && next !== "connecting") {
      this.#first = undefined
      if (next === "connected") first.resolve()
      else first.reject(closed)
    }
    for (const listener of [...this.#listeners]) {
      if (this.#notification !== revision) break
      try {
        listener(next)
      } catch (cause) {
        // UI observers must not interrupt transport cleanup or reconnection.
        console.error("Subduction connection subscriber failed", cause)
      }
    }
  }

  #clearRetry(): void {
    clearTimeout(this.#timer)
    this.#timer = undefined
  }

  #schedule(): void {
    if (
      this.#currentStatus !== "disconnected" ||
      !this.#retry ||
      this.#timer !== undefined
    )
      return
    const milliseconds = Math.max(
      1,
      Math.floor(this.#delay * (0.5 + Math.random() * 0.5))
    )
    this.#delay = Math.min(this.#maxMs, this.#delay * 2)
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      this.#attempt()
    }, milliseconds)
  }

  #attempt(): void {
    if (this.#isClosed()) return
    this.#clearRetry()
    if (this.#running) {
      this.#immediate = true
      this.#controller?.abort(new Error("Subduction reconnect requested"))
      if (!this.#isClosed()) this.#update("connecting")
      return
    }
    this.#immediate = false
    const attempt = new AbortController()
    const previous = this.#controller
    this.#controller = attempt
    const connect = this.#connect!
    // Defer callbacks until running is installed, including synchronous failures.
    this.#running = Promise.resolve()
      .then(async () => {
        if (attempt.signal.aborted || this.#isClosed()) return
        const deadline = setTimeout(() => {
          attempt.abort(new Error("Subduction connection timed out"))
        }, this.#timeoutMs)
        try {
          const url = new URL(this.url)
          const transport = await openTransport(url, attempt.signal, cause => {
            if (this.#controller !== attempt || this.#isClosed()) return
            attempt.abort(cause)
            if (this.#controller !== attempt || this.#isClosed()) return
            if (!this.#immediate) this.#update("disconnected", cause)
            if (!this.#running) this.#schedule()
          })
          attempt.signal.throwIfAborted()
          await connect(transport, { serviceName: this.#serviceName })
          attempt.signal.throwIfAborted()
          // Reset backoff only once the connection proves stable: a server
          // that drops every connection at once must not be hammered.
          const stable = setTimeout(() => {
            if (this.#controller === attempt) this.#delay = this.#initialMs
          }, this.#stableMs)
          attempt.signal.addEventListener("abort", () => clearTimeout(stable), {
            once: true,
          })
          this.#update("connected")
        } catch (cause) {
          if (this.#isClosed()) return
          if (cause instanceof BackendError && cause.code === "closed") {
            this.#update("closed", cause)
            this.#clearRetry()
            this.#listeners.clear()
          } else if (!this.#immediate)
            this.#update(
              "disconnected",
              attempt.signal.aborted ? attempt.signal.reason : cause
            )
          attempt.abort(cause)
        } finally {
          clearTimeout(deadline)
        }
      })
      .finally(() => {
        this.#running = undefined
        if (this.#isClosed()) return
        if (this.#immediate) this.#attempt()
        else this.#schedule()
      })
    previous?.abort(new Error("Subduction reconnect requested"))
    if (!this.#isClosed()) this.#update("connecting")
  }
}
