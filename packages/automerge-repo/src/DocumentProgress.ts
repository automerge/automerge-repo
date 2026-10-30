import type { DocHandle } from "./DocHandle.js"
import {
  stateError,
  waitUntilReady,
  type DocumentQuery,
  type QueryState,
} from "./DocumentQuery.js"
import type { DocumentId } from "./types.js"

/**
 * The deprecated {@link Repo.findWithProgress} surface. New code should use
 * {@link Repo.query}, which returns a {@link DocumentQuery}.
 */

/** @deprecated Use {@link Repo.query}. */
export type SourceState = "pending" | "ready" | "unavailable"

/** @deprecated Use {@link QueryState}. */
export type ProgressState<T> =
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

/** @deprecated Use {@link Repo.query}. Returned by {@link Repo.findWithProgress}. */
export interface DocumentProgress<T> {
  readonly documentId: DocumentId
  peek(): ProgressState<T>
  subscribe(callback: (state: ProgressState<T>) => void): () => void
  whenReady(options?: { signal?: AbortSignal }): Promise<DocHandle<T>>
}

/** Adapt a query to the deprecated {@link DocumentProgress} shape. */
export function toProgress<T>(query: DocumentQuery<T>): DocumentProgress<T> {
  const map = (state: QueryState<T>): ProgressState<T> => {
    switch (state.status) {
      case "loading":
        return { state: "loading", sources: { backend: "pending" } }
      case "ready":
        return {
          state: "ready",
          handle: state.handle,
          sources: { backend: "ready" },
        }
      case "unavailable":
        return { state: "unavailable", sources: { backend: "unavailable" } }
      default:
        return {
          state: "failed",
          error: stateError(query.documentId, state),
          sources: { backend: "unavailable" },
        }
    }
  }
  return {
    documentId: query.documentId,
    peek: () => map(query.state()),
    subscribe: callback => query.subscribe(state => callback(map(state))),
    whenReady: options => waitUntilReady(query, options?.signal),
  }
}
