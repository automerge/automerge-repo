import type { DocHandle } from "./types/DocHandle.js"
import type { HandleExtensionSpec } from "./sedimentree/extension.js"
import type { HandleKind } from "./DocType.js"
import type { AutomergeKind } from "./automerge/docType.js"
import type { DocumentId, UrlHeads } from "./types.js"
import { makeLogger } from "./Logger.js"

const log = makeLogger("automerge-repo:query")

/**
 * The readiness and availability of a document, as reported by
 * {@link Repo.query}.
 *
 * - `loading`: the Repo is still trying to obtain a usable snapshot.
 * - `ready`: a verified snapshot is available through `handle`.
 * - `unavailable`: the backend has verified that it currently has no history
 *   for this document. A later peer or store can still make it `ready`.
 * - `deleted`: the document was deleted locally. Terminal.
 * - `failed`: observation stopped with an error. Terminal.
 */
export type QueryState<
  T,
  X extends HandleExtensionSpec = {},
  K extends HandleKind = AutomergeKind,
> =
  | { status: "loading" }
  | { status: "ready"; handle: DocHandle<T, X, K> }
  | { status: "unavailable" }
  | { status: "deleted" }
  | { status: "failed"; error: Error }

/** An observable view of a document's readiness, returned by {@link Repo.query}. */
export interface DocumentQuery<
  T,
  X extends HandleExtensionSpec = {},
  K extends HandleKind = AutomergeKind,
> {
  readonly documentId: DocumentId
  /** The current state. */
  state(): QueryState<T, X, K>
  /**
   * Called synchronously with the current state, before `subscribe` returns,
   * then on every change. Returns an unsubscribe function.
   */
  subscribe(callback: (state: QueryState<T, X, K>) => void): () => void
}

/**
 * The single per-document query, driven by the Repo and its Document.
 * Terminal states (`deleted`, `failed`) ignore later reports.
 *
 * @internal
 */
export class RootQuery<T> implements DocumentQuery<T> {
  readonly documentId: DocumentId
  readonly #handle: DocHandle<T>
  #state: QueryState<T> = { status: "loading" }
  #subscribers = new Set<(state: QueryState<T>) => void>()

  constructor(handle: DocHandle<T>) {
    this.documentId = handle.documentId
    this.#handle = handle
  }

  state(): QueryState<T> {
    return this.#state
  }

  subscribe(callback: (state: QueryState<T>) => void): () => void {
    this.#subscribers.add(callback)
    deliver(callback, this.#state)
    return () => this.#subscribers.delete(callback)
  }

  /** Still waiting for a first verified snapshot. */
  get pending(): boolean {
    const { status } = this.#state
    return status === "loading" || status === "unavailable"
  }

  get terminal(): boolean {
    const { status } = this.#state
    return status === "deleted" || status === "failed"
  }

  ready(): void {
    if (this.pending)
      this.#transition({ status: "ready", handle: this.#handle })
  }

  unavailable(): void {
    if (this.pending) this.#transition({ status: "unavailable" })
  }

  deleted(): void {
    if (!this.terminal) this.#transition({ status: "deleted" })
  }

  fail(error: Error): void {
    if (!this.terminal) this.#transition({ status: "failed", error })
  }

  #transition(next: QueryState<T>): void {
    if (statesEqual(this.#state, next)) return
    this.#state = next
    notify(this.#subscribers, next)
  }
}

/**
 * Mirrors `query`, but stays `loading` until `heads` are in the document's
 * history, then yields a `view(heads)` handle. `onHeadsChanged` watches the
 * document's heads and returns an unsubscribe.
 */
export function queryAtHeads<
  T,
  X extends HandleExtensionSpec = {},
  K extends HandleKind = AutomergeKind,
>(
  query: DocumentQuery<T, X, K>,
  heads: UrlHeads,
  onHeadsChanged: (fn: () => void) => () => void
): DocumentQuery<T, X, K> {
  const state = (): QueryState<T, X, K> => {
    const upstream = query.state()
    if (upstream.status !== "ready") return upstream
    if (!upstream.handle.hasHeads(heads)) return { status: "loading" }
    const handle = upstream.handle.view(heads) as DocHandle<T, X, K>
    return { status: "ready", handle }
  }
  return {
    documentId: query.documentId,
    state,
    subscribe: callback => {
      let last: QueryState<T, X, K> | undefined
      const emit = () => {
        const next = state()
        if (last && statesEqual(last, next)) return
        last = next
        callback(next)
      }
      const detach = onHeadsChanged(emit)
      // The upstream's initial call delivers our first state.
      const unsubscribe = query.subscribe(emit)
      return () => {
        unsubscribe()
        detach()
      }
    },
  }
}

/**
 * Mirrors `query`, mapping a ready handle through `open` (e.g. a doc type's
 * `openPath`). Cached per upstream state so `open` runs once per ready
 * transition and `state()` agrees with subscribers. If `open` throws, this
 * query yields `failed`, terminally, while the upstream query is unaffected.
 */
export function queryMapped<
  T,
  X extends HandleExtensionSpec = {},
  K extends HandleKind = AutomergeKind,
>(
  query: DocumentQuery<T, X, K>,
  open: (handle: DocHandle<T, X, K>) => DocHandle<T, X, K>
): DocumentQuery<T, X, K> {
  let lastUpstream: QueryState<T, X, K> | undefined
  let lastMapped: QueryState<T, X, K> | undefined
  /** Set once `open` throws: `failed` is terminal, so later upstream states are ignored. */
  let openFailed = false
  const map = (state: QueryState<T, X, K>): QueryState<T, X, K> => {
    if (openFailed) return lastMapped!
    if (lastUpstream && statesEqual(lastUpstream, state)) return lastMapped!
    lastUpstream = state
    if (state.status !== "ready") return (lastMapped = state)
    try {
      return (lastMapped = { status: "ready", handle: open(state.handle) })
    } catch (error) {
      openFailed = true
      return (lastMapped = {
        status: "failed",
        error: error instanceof Error ? error : new Error(String(error)),
      })
    }
  }
  return {
    documentId: query.documentId,
    state: () => map(query.state()),
    subscribe: callback => {
      let delivered: QueryState<T, X, K> | undefined
      return query.subscribe(state => {
        const next = map(state)
        if (next === delivered) return
        delivered = next
        callback(next)
      })
    },
  }
}

/** Resolve with the handle once `query` is ready; reject on any other settled state. */
export function waitUntilReady<
  T,
  X extends HandleExtensionSpec = {},
  K extends HandleKind = AutomergeKind,
>(
  query: DocumentQuery<T, X, K>,
  signal?: AbortSignal
): Promise<DocHandle<T, X, K>> {
  return new Promise<DocHandle<T, X, K>>((resolve, reject) => {
    signal?.throwIfAborted()
    let unsubscribe: (() => void) | undefined
    let settled = false
    const cleanup = () => {
      settled = true
      unsubscribe?.()
      signal?.removeEventListener("abort", onAbort)
    }
    const onAbort = () => {
      cleanup()
      reject(signal!.reason)
    }
    const check = (state: QueryState<T, X, K>) => {
      if (settled || state.status === "loading") return
      cleanup()
      if (state.status === "ready") resolve(state.handle)
      else reject(stateError(query.documentId, state))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    unsubscribe = query.subscribe(check)
    // The initial call may settle before `unsubscribe` is assigned.
    if (settled) unsubscribe()
  })
}

/** @internal The rejection reason for a settled, non-ready state. */
export function stateError(
  documentId: DocumentId,
  state: QueryState<unknown>
): Error {
  switch (state.status) {
    case "failed":
      return state.error
    case "deleted":
      return new Error(`Document ${documentId} was deleted`)
    default:
      return new Error(`Document ${documentId} is unavailable`)
  }
}

function notify<S>(subscribers: Set<(state: S) => void>, state: S): void {
  for (const callback of [...subscribers]) deliver(callback, state)
}

/** Subscriber errors, sync or async, are logged rather than propagated. */
function deliver<S>(callback: (state: S) => void, state: S): void {
  try {
    void Promise.resolve(callback(state)).catch(error => {
      log.error("error in query subscriber: %o", error)
    })
  } catch (error) {
    log.error("error in query subscriber: %o", error)
  }
}

function statesEqual(
  a: QueryState<any, any, any>,
  b: QueryState<any, any, any>
): boolean {
  if (a.status !== b.status) return false
  if (a.status === "ready" && b.status === "ready") return a.handle === b.handle
  if (a.status === "failed" && b.status === "failed") return a.error === b.error
  return true
}
