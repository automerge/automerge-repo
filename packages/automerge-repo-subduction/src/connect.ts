import { BackendError } from "@automerge/automerge-repo/sedimentree"
import type { NativeSigner, SubductionBackend } from "./index.js"
import { openTransport } from "./websocket.js"
import { observeBackendClose } from "./backendLifecycle.js"

export type SubductionServer =
  | string
  | URL
  | { url: string | URL; serviceName?: string }
export type SubductionConnectionStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "closed"

export interface SubductionConnectionOptions {
  retry?: false | { initialMs?: number; maxMs?: number }
  /** Deadline for socket opening, authentication and backend onboarding. Default: 10s. */
  connectTimeoutMilliseconds?: number
}

export interface SubductionConnection {
  readonly url: string
  readonly status: SubductionConnectionStatus
  readonly error: unknown
  /** Called immediately, then on state changes. */
  subscribe(callback: (status: SubductionConnectionStatus) => void): () => void
  /** Wait for a connection, across automatic retries. Rejects on close. */
  connected(): Promise<void>
  /** Cancel the current attempt/connection and retry immediately. */
  reconnect(): void
  close(): Promise<void>
}

/** Starts immediately. Borrows backend and signer; closes only its own socket. */
export function connectSubductionServer(
  backend: SubductionBackend,
  signer: NativeSigner,
  server: SubductionServer,
  options: SubductionConnectionOptions = {}
): SubductionConnection {
  const config =
    typeof server === "string" || server instanceof URL
      ? { url: server }
      : server
  const url = new URL(config.url)
  const serviceName = config.serviceName ?? url.host
  if (url.protocol !== "ws:" && url.protocol !== "wss:")
    throw new TypeError("Subduction servers must use ws: or wss:")
  const retry = options.retry !== false
  const initialMs = options.retry ? (options.retry.initialMs ?? 500) : 500
  const maxMs = options.retry ? (options.retry.maxMs ?? 30_000) : 30_000
  const timeoutMs = options.connectTimeoutMilliseconds ?? 10_000
  for (const value of [initialMs, maxMs, timeoutMs])
    if (!Number.isSafeInteger(value) || value <= 0 || value > 0x7fffffff)
      throw new TypeError(
        "Connection delays must be positive timer-safe integers"
      )
  if (maxMs < initialMs) throw new TypeError("maxMs must be at least initialMs")

  let status: SubductionConnectionStatus = "connecting"
  let error: unknown
  let delay = initialMs
  let timer: ReturnType<typeof setTimeout> | undefined
  let controller: AbortController | undefined
  let running: Promise<void> | undefined
  let closing: Promise<void> | undefined
  let immediate = false
  let notification = 0
  let unobserveClose: (() => void) | undefined
  const listeners = new Set<(status: SubductionConnectionStatus) => void>()
  const waiters = new Set<{ resolve(): void; reject(cause: unknown): void }>()
  const isClosed = () => status === "closed"

  function update(next: SubductionConnectionStatus, cause?: unknown) {
    if (status === next && error === cause) return
    const revision = ++notification
    status = next
    error = cause
    if (
      next === "connected" ||
      next === "closed" ||
      (next === "disconnected" && !retry && !immediate)
    ) {
      for (const waiter of waiters) {
        if (next === "connected") waiter.resolve()
        else waiter.reject(cause ?? new Error("Subduction connection closed"))
      }
      waiters.clear()
    }
    for (const listener of [...listeners]) {
      if (notification !== revision) break
      try {
        listener(next)
      } catch (cause) {
        // UI observers must not interrupt transport cleanup or reconnection.
        console.error("Subduction connection subscriber failed", cause)
      }
    }
  }

  function clearRetry() {
    clearTimeout(timer)
    timer = undefined
  }

  function schedule() {
    if (status !== "disconnected" || !retry || timer !== undefined) return
    const milliseconds = Math.max(
      1,
      Math.floor(delay * (0.5 + Math.random() * 0.5))
    )
    delay = Math.min(maxMs, delay * 2)
    timer = setTimeout(() => {
      timer = undefined
      start()
    }, milliseconds)
  }

  function start() {
    if (status === "closed") return
    clearRetry()
    if (running) {
      immediate = true
      controller?.abort(new Error("Subduction reconnect requested"))
      if (!isClosed()) update("connecting")
      return
    }
    immediate = false
    const attempt = new AbortController()
    const previous = controller
    controller = attempt
    // Defer callbacks until running is installed, including synchronous failures.
    running = Promise.resolve()
      .then(async () => {
        if (attempt.signal.aborted || status === "closed") return
        const deadline = setTimeout(() => {
          attempt.abort(new Error("Subduction connection timed out"))
        }, timeoutMs)
        try {
          const transport = await openTransport(
            url,
            signer,
            serviceName,
            attempt.signal,
            cause => {
              if (controller !== attempt || status === "closed") return
              attempt.abort(cause)
              if (controller !== attempt || isClosed()) return
              if (!immediate) update("disconnected", cause)
              if (!running) schedule()
            }
          )
          try {
            attempt.signal.throwIfAborted()
            await backend.addConnection(transport)
            attempt.signal.throwIfAborted()
            delay = initialMs
            update("connected")
          } finally {
            transport.free()
          }
        } catch (cause) {
          if (isClosed()) return
          if (cause instanceof BackendError && cause.code === "closed") {
            update("closed", cause)
            clearRetry()
            listeners.clear()
            unobserveClose?.()
          } else if (!immediate)
            update(
              "disconnected",
              attempt.signal.aborted ? attempt.signal.reason : cause
            )
          attempt.abort(cause)
        } finally {
          clearTimeout(deadline)
        }
      })
      .finally(() => {
        running = undefined
        if (status === "closed") return
        if (immediate) start()
        else schedule()
      })
    previous?.abort(new Error("Subduction reconnect requested"))
    if (!isClosed()) update("connecting")
  }

  const connection: SubductionConnection = {
    url: url.href,
    get status() {
      return status
    },
    get error() {
      return error
    },
    subscribe(callback) {
      if (status !== "closed") listeners.add(callback)
      callback(status)
      return () => {
        listeners.delete(callback)
      }
    },
    connected() {
      if (status === "connected") return Promise.resolve()
      if (status === "closed" || (status === "disconnected" && !retry))
        return Promise.reject(
          error ?? new Error("Subduction connection closed")
        )
      return new Promise((resolve, reject) => waiters.add({ resolve, reject }))
    },
    reconnect() {
      if (status === "closed") return
      start()
    },
    close() {
      if (closing) return closing
      closing = Promise.resolve().then(async () => {
        await running
      })
      clearRetry()
      update("closed")
      listeners.clear()
      unobserveClose?.()
      controller?.abort(new Error("Subduction connection closed"))
      return closing
    },
  }
  unobserveClose = observeBackendClose(backend, () => {
    void connection.close()
  })
  start()
  return connection
}
