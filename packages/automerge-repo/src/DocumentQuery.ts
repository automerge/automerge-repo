import { next as Automerge } from "@automerge/automerge/slim"
import { DocHandle } from "./DocHandle.js"
import { decodeHeads } from "./AutomergeUrl.js"
import type { DocumentId, UrlHeads } from "./types.js"
import type { Segment } from "./subdoc-handles/types.js"
import { AbortError } from "./helpers/abortable.js"
import { type FindProgress, queryStateToFindProgress } from "./_compat.js"

/**
 * The state a {@link DocumentSource} reports for a particular document.
 *
 * - `pending`: the source is actively trying to obtain data (sync in
 *   progress, storage lookup outstanding, etc.).
 * - `ready`: the source has delivered everything it currently knows about.
 *   For storage, this means the on-disk doc has been loaded; for the
 *   automerge sync source, this means we've caught up to at least one
 *   connected peer's advertised initial heads.
 * - `unavailable`: the source has determined it cannot provide data.
 *
 * Sources may transition between these states freely (e.g. sync can go
 * `ready` → `pending` again when a new peer arrives advertising heads
 * we don't have).
 */
export type SourceState = "pending" | "ready" | "unavailable"

export type QueryState<T> =
  | { state: "loading"; sources: Record<string, SourceState> }
  | {
      state: "ready"
      handle: DocHandle<T>
      sources: Record<string, SourceState>
    }
  | { state: "unavailable"; sources: Record<string, SourceState> }
  | {
      state: "failed"
      error: Error
      sources: Record<string, SourceState>
    }

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

  /**
   * @deprecated read via `peek().state`. Will be removed in the next major
   * release.
   */
  // TODO: remove in the next major
  get state(): FindProgress<T>["state"]

  /**
   * @deprecated Will be removed in the next major release.
   */
  // TODO: remove in the next major
  get progress(): number | undefined

  /** @deprecated read via `peek()` — `error` is only set on the `failed` state. Will be removed in the next major release. */
  // TODO: remove in the next major
  get error(): Error | undefined
}

/** Higher numbers represent earlier availability tiers. */
export type SourcePriority = number
type SourceInfo = { state: SourceState; priority: SourcePriority }

const DEFAULT_SOURCE_PRIORITY = 0

/**
 * A live query for a document. Tracks the ongoing attempt to obtain a document
 * from one or more sources (storage, automerge sync, etc.).
 *
 * The query derives its overall state from the handle and source states:
 *
 * - Handle has data (non-empty heads) → `ready`
 * - No data, any source is `pending` → `loading`
 * - No data, all sources are `unavailable` → `unavailable`
 *
 * Sources report whether they are still trying (`sourcePending`) or have
 * given up (`sourceUnavailable`). The query detects data arrival
 * automatically by listening to the handle's `heads-changed` event.
 *
 * Each {@link QueryState} also carries a `sources` map exposing the latest
 * reported state of every registered source, so consumers can distinguish
 * e.g. "ready, but sync is still in flight" from "ready and quiescent".
 *
 * The public-facing API is `DocumentProgress<T>`, which exposes only the
 * read-only observation methods.
 *
 * There are a bunch of things in here which only exist for compatibility with
 * earlier versions of the library. The interface introduced in automerge-repo
 * v2 had `state`, `handle`, `error`, and `progress` properties directly on
 * the result object returned by `findWithProgress`. The new `peek()` method
 * replaces these legacy properties - they should be removed in the next major.
 */
export class DocumentQuery<T> implements DocumentProgress<T> {
  readonly documentId: DocumentId

  #handle: DocHandle<T>
  #sources = new Map<string, SourceInfo>()
  #subscribers = new Set<(state: QueryState<T>) => void>()
  #state: QueryState<T>
  #failed = false

  constructor(
    handle: DocHandle<T>,
    sources: Map<string, { priority: SourcePriority }> = new Map()
  ) {
    this.documentId = handle.documentId
    this.#handle = handle
    // New sources are treated as `pending` from registration: we expect them
    // to do work and want them to gate availability decisions until they
    // actually report in.
    this.#sources = new Map(
      Array.from(sources, ([source, { priority }]) => [
        source,
        { state: "pending" as SourceState, priority },
      ])
    )
    this.#state = this.#computeState()
    this.#handle.on("heads-changed", () => this.#recompute())
  }

  peek(): QueryState<T> {
    return this.#state
  }

  /** @deprecated read via `peek().state`. Will be removed in the next major. */
  get state(): FindProgress<T>["state"] {
    return queryStateToFindProgress(this.#state, this.#handle).state
  }

  /** @deprecated read via `peek()` — `handle` is only set on the `ready` state. Will be removed in the next major. */
  get progress(): number | undefined {
    const legacy = queryStateToFindProgress(this.#state, this.#handle)
    return legacy.state === "loading" ? legacy.progress : undefined
  }

  /** @deprecated read via `peek()` — `error` is only set on the `failed` state. Will be removed in the next major. */
  get error(): Error | undefined {
    return this.#state.state === "failed" ? this.#state.error : undefined
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
    this.#setSource(source, "pending")
    this.#recompute()
  }

  /**
   * A source has delivered everything it currently knows about (e.g.
   * storage finished loading and applied the doc, or sync caught up to a
   * peer's advertised initial heads). Distinct from `sourceUnavailable`,
   * which means "I have nothing for you."
   */
  sourceReady(source: string): void {
    if (this.#failed) return
    this.#setSource(source, "ready")
    this.#recompute()
  }

  /**
   * A source has determined it cannot provide data right now (e.g. sync
   * completed with no peers, or no data in local storage). The query
   * transitions to `unavailable` if no source is still pending and the
   * handle has no data.
   */
  sourceUnavailable(source: string): void {
    if (this.#failed) return
    this.#setSource(source, "unavailable")
    this.#recompute()
  }

  /**
   * Should the named source defer making availability decisions because a
   * higher-priority source is still working? Returns `true` when at least
   * one strictly-higher-priority source is in the `pending` state, meaning
   * the caller should hold off on actions (e.g. fanning out requests to
   * peers) that would commit it to an availability conclusion.
   */
  shouldDeferAvailability(source: string): boolean {
    const myPriority = this.#sourcePriority(source)
    for (const other of this.#sources.values()) {
      if (other.state === "pending" && other.priority > myPriority) return true
    }
    return false
  }

  /**
   * Terminal failure. The query transitions to `failed` and stays there.
   */
  fail(error: Error): void {
    this.#failed = true
    this.#transition({ state: "failed", error, sources: this.#sourcesView() })
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

  #sourcePriority(source: string): SourcePriority {
    return this.#sources.get(source)?.priority ?? DEFAULT_SOURCE_PRIORITY
  }

  #setSource(source: string, state: SourceState): void {
    const priority = this.#sourcePriority(source)
    this.#sources.set(source, { state, priority })
  }

  #recompute(): void {
    if (this.#failed) return
    this.#transition(this.#computeState())
  }

  /** Build the next public state from the current handle and source map. */
  #computeState(): QueryState<T> {
    const sources = this.#sourcesView()

    // Handle has data → ready, regardless of source states
    if (this.#handleHasData()) {
      return { state: "ready", handle: this.#handle, sources }
    }

    // No data yet — consult sources

    // If any source is still working, we're loading
    if (this.#hasAnySource("pending")) {
      return { state: "loading", sources }
    }

    // All sources have settled (ready or unavailable) and we still have no
    // data — nothing more is coming.
    return { state: "unavailable", sources }
  }

  #sourcesView(): Record<string, SourceState> {
    const out: Record<string, SourceState> = {}
    for (const [name, info] of this.#sources) out[name] = info.state
    return out
  }

  #transition(next: QueryState<T>): void {
    if (statesEqual(this.#state, next)) return
    this.#state = next
    for (const callback of this.#subscribers) {
      callback(next)
    }
  }

  #hasAnySource(state: SourceState): boolean {
    for (const s of this.#sources.values()) {
      if (s.state === state) return true
    }
    return false
  }
}

function statesEqual<T>(a: QueryState<T>, b: QueryState<T>): boolean {
  if (a.state !== b.state) return false
  if (a.state === "ready" && b.state === "ready" && a.handle !== b.handle) {
    return false
  }
  // `failed` is terminal and only reached via fail(), which is called once
  // per query — its error doesn't churn, so we don't compare it here.
  return sourceMapsEqual(a.sources, b.sources)
}

function sourceMapsEqual(
  a: Record<string, SourceState>,
  b: Record<string, SourceState>
): boolean {
  const aKeys = Object.keys(a)
  if (aKeys.length !== Object.keys(b).length) return false
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false
  }
  return true
}

/**
 * Returns a {@link DocumentProgress} that mirrors `query` but only resolves
 * to `ready` once the requested `heads` are present in the underlying
 * document's history (and then yields a `view(heads)` snapshot). Used by
 * `findWithProgress(urlWithHeads)` so callers that pass heads in the URL
 * don't see a doc that pre-dates those heads.
 */
export function progressAtHeads<T>(
  query: DocumentQuery<T>,
  heads: UrlHeads
): DocumentProgress<T> {
  const decoded = decodeHeads(heads)

  const stateAtHeads = (): QueryState<T> => {
    const upstream = query.peek()
    if (upstream.state !== "ready") return upstream
    if (!Automerge.hasHeads(upstream.handle.fullDoc(), decoded)) {
      return { state: "loading", sources: upstream.sources }
    }
    return {
      state: "ready",
      handle: upstream.handle.view(heads),
      sources: upstream.sources,
    }
  }

  return {
    documentId: query.documentId,
    peek: stateAtHeads,
    subscribe: cb => {
      let last = stateAtHeads()
      let detachHandle: (() => void) | undefined

      const emit = () => {
        const next = stateAtHeads()
        // Dedupe on the same structural-equality basis as DocumentQuery.
        if (statesEqual(last, next)) return
        last = next
        cb(next)
      }

      const attachHandle = (handle: DocHandle<T>) => {
        if (detachHandle) return
        handle.on("heads-changed", emit)
        detachHandle = () => handle.off("heads-changed", emit)
      }

      const unsubQuery = query.subscribe(state => {
        if (state.state === "ready") attachHandle(state.handle)
        emit()
      })

      const initial = query.peek()
      if (initial.state === "ready") attachHandle(initial.handle)

      return () => {
        unsubQuery()
        detachHandle?.()
      }
    },
    whenReady: async opts => {
      const upstream = await query.whenReady(opts)
      if (Automerge.hasHeads(upstream.fullDoc(), decoded)) {
        return upstream.view(heads)
      }
      return new Promise<DocHandle<T>>((resolve, reject) => {
        const onAbort = () => {
          cleanup()
          reject(new AbortError())
        }
        const onChange = () => {
          if (Automerge.hasHeads(upstream.fullDoc(), decoded)) {
            cleanup()
            resolve(upstream.view(heads))
          }
        }
        const cleanup = () => {
          upstream.off("heads-changed", onChange)
          opts?.signal?.removeEventListener("abort", onAbort)
        }
        upstream.on("heads-changed", onChange)
        opts?.signal?.addEventListener("abort", onAbort)
      })
    },
    // Deprecated v2-shape getters — pass through the underlying query's
    // discriminator. Callers using these read `.handle` off `peek()` instead.
    get state() {
      return query.state
    },
    get progress() {
      return query.progress
    },
    get error() {
      return query.error
    },
  }
}

/**
 * Returns a {@link DocumentProgress} that mirrors `inner` but yields a
 * sub-handle scoped to `segments` once ready (e.g. for an
 * `automerge:<id>/items/@0` URL). Used by `findWithProgress` so that
 * path-suffixed URLs resolve directly to a scoped handle, without each
 * consumer having to re-apply the path. Readiness is unchanged - it stays
 * a document-level concern; the scoped value may be `undefined` if the path
 * doesn't (yet) resolve.
 */
export function progressAtPath<T>(
  inner: DocumentProgress<T>,
  segments: Segment[]
): DocumentProgress<T> {
  const scope = (handle: DocHandle<T>): DocHandle<T> =>
    handle.sub(...(segments as any[])) as DocHandle<T>

  const mapState = (s: QueryState<T>): QueryState<T> =>
    s.state === "ready" ? { ...s, handle: scope(s.handle) } : s

  return {
    documentId: inner.documentId,
    peek: () => mapState(inner.peek()),
    subscribe: cb => inner.subscribe(s => cb(mapState(s))),
    whenReady: async opts => scope(await inner.whenReady(opts)),
    get state() {
      return inner.state
    },
    get progress() {
      return inner.progress
    },
    get error() {
      return inner.error
    },
  }
}
