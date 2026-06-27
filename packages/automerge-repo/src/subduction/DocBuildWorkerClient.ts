/**
 * Main-thread client for a POOL of doc-build Workers. Ships merged blob bytes to
 * one of N workers (round-robin) and resolves with the compact snapshot that
 * worker produced (a `save()` of `loadIncremental(init(), merged)`), which the
 * caller applies via `Automerge.loadIncremental(doc, snapshot)`.
 *
 * Why a pool (vs a single worker): during a bulk cold load several docs can
 * materialise in parallel (bounded by cores), and one slow doc no longer
 * head-of-line-blocks the docs queued behind it. The win plateaus once the
 * worker build is no longer the bottleneck (the main thread still applies each
 * snapshot serially), so a small pool (default 3) is the sweet spot.
 *
 * This pool is INDEPENDENT of the IndexedDB storage worker — separate threads,
 * separate jobs. Each worker is spawned internally via
 * `new Worker(new URL("./docBuild.worker.js", import.meta.url), { type: "module" })`
 * — Vite/webpack bundle it for the consumer.
 *
 * Timings (including failed/cancelled builds) are recorded into
 * {@link subductionTimings} when it is enabled.
 */
import { DOC_BUILD_RPC, type DocBuildResponse } from "./docBuildRpc.js"
import { subductionTimings } from "./timing.js"

/** Default number of doc-build workers in the pool. */
export const DEFAULT_DOC_BUILD_POOL_SIZE = 3

export interface DocBuildWorkerPoolOptions {
  /** Number of workers to spawn. Defaults to {@link DEFAULT_DOC_BUILD_POOL_SIZE}.
   *  Ignored when `workers` is supplied. Clamped to >= 1. */
  poolSize?: number

  /** Pre-built workers to adopt (e.g. for tests). When given, the client does
   *  not spawn or terminate them. */
  workers?: Worker[]
}

/** Rejection reason when a build is abandoned because the pool was disposed or a
 *  worker crashed mid-flight. Lets callers distinguish a cancellation from a
 *  genuine build failure. */
export class DocBuildCancelledError extends Error {
  constructor(message = "doc-build request cancelled") {
    super(message)
    this.name = "DocBuildCancelledError"
  }
}

interface Pending {
  resolve: (snapshot: Uint8Array) => void
  reject: (e: unknown) => void
  worker: number
  dispatchTs: number
  bytes: number
}

export class DocBuildWorkerClient {
  #workers: Worker[]
  #ownsWorkers: boolean
  #nextId = 0
  /** Round-robin cursor into `#workers`. */
  #next = 0
  #pending = new Map<number, Pending>()
  #errorListeners: Array<(e: Event) => void> = []

  constructor(options: DocBuildWorkerPoolOptions = {}) {
    if (options.workers && options.workers.length > 0) {
      this.#workers = options.workers
      this.#ownsWorkers = false
    } else {
      const size = Math.max(
        1,
        Math.floor(options.poolSize ?? DEFAULT_DOC_BUILD_POOL_SIZE)
      )
      this.#workers = Array.from(
        { length: size },
        () =>
          new Worker(new URL("./docBuild.worker.js", import.meta.url), {
            type: "module",
          })
      )
      this.#ownsWorkers = true
    }

    this.#workers.forEach((w, index) => {
      w.addEventListener("message", this.#onMessage)
      const onError = (ev: Event) => this.#onWorkerError(index, ev)
      this.#errorListeners[index] = onError
      w.addEventListener("error", onError)
    })
  }

  /** Number of workers in the pool. */
  get size(): number {
    return this.#workers.length
  }

  /** Number of builds currently in flight. */
  get inFlight(): number {
    return this.#pending.size
  }

  // Request ids are unique across the whole pool, so a single `#pending` map
  // demultiplexes responses no matter which worker replies.
  #onMessage = (e: MessageEvent) => {
    const msg = e.data as DocBuildResponse
    if (!msg || msg.channel !== DOC_BUILD_RPC) return
    const pending = this.#pending.get(msg.id)
    if (!pending) return
    this.#pending.delete(msg.id)

    const wall = performance.now() - pending.dispatchTs
    if (msg.ok) {
      const t = msg.timing
      this.#record("ok", pending, wall, undefined, {
        buildMs: t.buildMs,
        saveMs: t.saveMs,
        queueMs: Math.max(0, wall - t.buildMs - t.saveMs),
        snapshotBytes: t.snapshotBytes,
      })
      pending.resolve(msg.snapshot)
    } else {
      this.#record("failed", pending, wall, msg.error, {
        failedAfterMs: msg.failedAfterMs ?? wall,
      })
      pending.reject(new Error(msg.error))
    }
  }

  // A worker `error` event isn't tied to one message, so every build in flight
  // on that worker is dead — fail them all.
  #onWorkerError(index: number, ev: Event) {
    const message =
      ev instanceof ErrorEvent && ev.message ? ev.message : "worker error"
    for (const [id, pending] of this.#pending) {
      if (pending.worker !== index) continue
      this.#pending.delete(id)
      this.#record(
        "failed",
        pending,
        performance.now() - pending.dispatchTs,
        message
      )
      pending.reject(new Error(message))
    }
  }

  #record(
    outcome: "ok" | "failed" | "cancelled",
    pending: Pending,
    ms: number,
    error?: string,
    extra?: Record<string, number>
  ) {
    if (!subductionTimings.enabled) return
    subductionTimings.record({
      ts: performance.now(),
      phase: "worker-rtt",
      outcome,
      worker: pending.worker,
      ms,
      bytes: pending.bytes,
      error,
      extra,
    })
  }

  /** Build the doc from `merged` in the next pool worker (round-robin); resolves
   *  with a compact snapshot. Rejects with {@link DocBuildCancelledError} if the
   *  pool is disposed (or the worker crashes) before it completes. */
  build(merged: Uint8Array): Promise<Uint8Array> {
    const id = this.#nextId++
    const worker = this.#next
    this.#next = (this.#next + 1) % this.#workers.length
    return new Promise((resolve, reject) => {
      this.#pending.set(id, {
        resolve,
        reject,
        worker,
        dispatchTs: performance.now(),
        bytes: merged.byteLength,
      })
      // Transfer a copy so the caller's `merged` is never detached.
      const copy = merged.slice()
      this.#workers[worker].postMessage(
        { channel: DOC_BUILD_RPC, id, merged: copy },
        [copy.buffer]
      )
    })
  }

  dispose(): void {
    // Cancel everything still in flight (records as `cancelled`).
    for (const [, pending] of this.#pending) {
      this.#record(
        "cancelled",
        pending,
        performance.now() - pending.dispatchTs,
        "pool disposed"
      )
      pending.reject(new DocBuildCancelledError())
    }
    this.#pending.clear()

    this.#workers.forEach((w, index) => {
      w.removeEventListener("message", this.#onMessage)
      const onError = this.#errorListeners[index]
      if (onError) w.removeEventListener("error", onError)
      if (this.#ownsWorkers) w.terminate()
    })
    this.#errorListeners = []
  }
}
