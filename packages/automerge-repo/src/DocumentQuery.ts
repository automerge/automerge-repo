import type { DocHandle } from "./types/DocHandle.js"
import type { HandleExtensionSpec } from "./sedimentree/extension.js"
import type { AnyDocType } from "./DocType.js"
import type { AutomergeDocType } from "./automerge/docType.js"
import type { DocumentId, UrlHeads } from "./types.js"
import type { Segment } from "./subdoc-handles/types.js"
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
  D extends AnyDocType = AutomergeDocType,
> =
  | { status: "loading" }
  | { status: "ready"; handle: DocHandle<T, X, D> }
  | { status: "unavailable" }
  | { status: "deleted" }
  | { status: "failed"; error: Error }

/** An observable view of a document's readiness, returned by {@link Repo.query}. */
export interface DocumentQuery<
  T,
  X extends HandleExtensionSpec = {},
  D extends AnyDocType = AutomergeDocType,
> {
  readonly documentId: DocumentId
  /** The current state. */
  state(): QueryState<T, X, D>
  /**
   * Called synchronously with the current state, before `subscribe` returns,
   * then on every change. Returns an unsubscribe function.
   */
  subscribe(callback: (state: QueryState<T, X, D>) => void): () => void
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
  D extends AnyDocType = AutomergeDocType,
>(
  query: DocumentQuery<T, X, D>,
  heads: UrlHeads,
  onHeadsChanged: (fn: () => void) => () => void
): DocumentQuery<T, X, D> {
  const state = (): QueryState<T, X, D> => {
    const upstream = query.state()
    if (upstream.status !== "ready") return upstream
    if (!upstream.handle.hasHeads(heads)) return { status: "loading" }
    const handle = upstream.handle.view(heads) as DocHandle<T, X, D>
    return { status: "ready", handle }
  }
  return {
    documentId: query.documentId,
    state,
    subscribe: callback => {
      let last: QueryState<T, X, D> | undefined
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

/** Mirrors `query`, yielding a sub-handle scoped to `segments` once ready. */
export function queryAtPath<T, X extends HandleExtensionSpec = {}>(
  query: DocumentQuery<T, X>,
  segments: Segment[]
): DocumentQuery<T, X> {
  const map = (state: QueryState<T, X>): QueryState<T, X> =>
    state.status === "ready"
      ? {
          status: "ready",
          handle: state.handle.sub(...(segments as any[])) as DocHandle<T, X>,
        }
      : state
  return {
    documentId: query.documentId,
    state: () => map(query.state()),
    subscribe: callback => query.subscribe(state => callback(map(state))),
  }
}

/** Resolve with the handle once `query` is ready; reject on any other settled state. */
export function waitUntilReady<
  T,
  X extends HandleExtensionSpec = {},
  D extends AnyDocType = AutomergeDocType,
>(
  query: DocumentQuery<T, X, D>,
  signal?: AbortSignal
): Promise<DocHandle<T, X, D>> {
  return new Promise<DocHandle<T, X, D>>((resolve, reject) => {
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
    const check = (state: QueryState<T, X, D>) => {
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
