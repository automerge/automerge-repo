import type { next as Automerge } from "@automerge/automerge/slim"
import { DocHandle } from "./DocHandle.js"
import type { DocumentId } from "./types.js"
import { AbortError } from "./helpers/abortable.js"

export type QueryState<T> =
  | { state: "loading" }
  | { state: "ready"; handle: DocHandle<T> }
  | { state: "unavailable" }
  | { state: "failed"; error: Error }

/**
 * Read-only view of a document query. Returned by {@link Repo.findWithProgress}
 */
export interface DocumentProgress<T> {
  readonly documentId: DocumentId

  /** Returns the current state of the query. */
  peek(): QueryState<T>

  /**
   * Subscribe to state changes. The callback fires whenever the query
   * transitions to a new state. Returns an unsubscribe function.
   */
  subscribe(callback: (state: QueryState<T>) => void): () => void

  /**
   * Returns a promise that resolves with the DocHandle when the query reaches
   * the `ready` state. Rejects if the query fails or the signal is aborted.
   */
  whenReady(options?: { signal?: AbortSignal }): Promise<DocHandle<T>>
}

type SourceState = "pending" | "unavailable"

/**
 * A live query for a document. Tracks the ongoing attempt to obtain a document
 * from one or more sources (storage, automerge sync, etc.).
 *
 * The query derives its overall state from the handle and source states:
 *
 * - Handle has data (non-empty heads) → `ready`
 * - No data, any source is `pending` → `loading`
 * - No data, all sources `unavailable` → `unavailable`
 *
 * Sources report whether they are still trying (`sourcePending`) or have
 * given up (`sourceUnavailable`). The query detects data arrival
 * automatically by listening to the handle's `heads-changed` event.
 *
 * The public-facing API is `DocumentProgress<T>`, which exposes only the
 * read-only observation methods.
 */
export class DocumentQuery<T> implements DocumentProgress<T> {
  readonly documentId: DocumentId

  #handle: DocHandle<T>
  #sources = new Map<string, SourceState>()
  #subscribers = new Set<(state: QueryState<T>) => void>()
  #state: QueryState<T> = { state: "loading" }
  #failed = false

  constructor(documentId: DocumentId, initialDoc?: Automerge.Doc<unknown>) {
    this.documentId = documentId
    this.#handle = new DocHandle(this.documentId)
    if (initialDoc) {
      this.#handle.update(() => initialDoc as Automerge.Doc<T>)
    }
    this.#handle.on("heads-changed", () => this.#recompute())
    // Compute initial state (handles case where initialDoc was provided)
    this.#recompute()
  }

  // -- Consumer methods (DocumentProgress interface) --

  peek(): QueryState<T> {
    return this.#state
  }

  subscribe(callback: (state: QueryState<T>) => void): () => void {
    this.#subscribers.add(callback)
    return () => this.#subscribers.delete(callback)
  }

  async whenReady(options?: { signal?: AbortSignal }): Promise<DocHandle<T>> {
    const signal = options?.signal
    if (signal?.aborted) throw new AbortError()

    // Already ready — return immediately
    if (this.#state.state === "ready") return this.#state.handle

    // Already terminally failed — reject immediately
    if (this.#state.state === "failed") throw this.#state.error

    // Already unavailable — reject immediately
    if (this.#state.state === "unavailable") {
      throw new Error(`Document ${this.documentId} is unavailable`)
    }

    return new Promise<DocHandle<T>>((resolve, reject) => {
      const onAbort = () => {
        cleanup()
        reject(new AbortError())
      }

      const unsubscribe = this.subscribe(state => {
        if (state.state === "ready") {
          cleanup()
          resolve(state.handle)
        } else if (state.state === "failed") {
          cleanup()
          reject(state.error)
        } else if (state.state === "unavailable") {
          cleanup()
          reject(new Error(`Document ${this.documentId} is unavailable`))
        }
      })

      const cleanup = () => {
        unsubscribe()
        signal?.removeEventListener("abort", onAbort)
      }

      signal?.addEventListener("abort", onAbort)
    })
  }

  // -- Source methods (internal only) --

  /**
   * A source is actively working on obtaining the document (e.g. sync in
   * progress, waiting for a peer to respond). If the query was `unavailable`,
   * it transitions back to `loading`.
   *
   * This is the initial state for a newly registered source, so this method
   * is only needed when re-entering pending (e.g. a new peer connects and
   * we want to retry).
   */
  sourcePending(source: string): void {
    if (this.#failed) return
    this.#sources.set(source, "pending")
    this.#recompute()
  }

  /**
   * A source has determined it cannot provide data right now (e.g. sync
   * completed with no peers, or no data in local storage). The query
   * transitions to `unavailable` only if ALL registered sources are
   * unavailable and the handle has no data.
   */
  sourceUnavailable(source: string): void {
    if (this.#failed) return
    this.#sources.set(source, "unavailable")
    this.#recompute()
  }

  /**
   * Terminal failure. The query transitions to `failed` and stays there.
   */
  fail(error: Error): void {
    this.#failed = true
    this.#transition({ state: "failed", error })
  }

  /**
   * Returns the DocHandle if one has been created, or null. This is used
   * internally by the Repo for operations on existing handles (e.g. delete,
   * export).
   */
  get handle(): DocHandle<T> {
    return this.#handle
  }

  // -- Internal --

  #handleHasData(): boolean {
    const heads = this.#handle.heads()
    return heads.length > 0
  }

  #recompute(): void {
    if (this.#failed) return

    // Handle has data → ready, regardless of source states
    if (this.#handleHasData()) {
      this.#transition({ state: "ready", handle: this.#handle })
      return
    }

    // No data yet — consult sources

    // If any source is still working, we're loading
    if (this.#hasAnySource("pending")) {
      this.#transition({ state: "loading" })
      return
    }

    // All sources have given up
    if (this.#sources.size > 0 && this.#allSources("unavailable")) {
      this.#transition({ state: "unavailable" })
      return
    }

    // No sources registered yet — stay loading
    this.#transition({ state: "loading" })
  }

  #transition(next: QueryState<T>): void {
    if (this.#state.state === next.state) return
    this.#state = next
    for (const callback of this.#subscribers) {
      callback(next)
    }
  }

  #hasAnySource(state: SourceState): boolean {
    for (const s of this.#sources.values()) {
      if (s === state) return true
    }
    return false
  }

  #allSources(state: SourceState): boolean {
    for (const s of this.#sources.values()) {
      if (s !== state) return false
    }
    return true
  }
}
