import type { ExtendedHandle } from "./DocHandle.js"
import type { HandleExtension } from "./sedimentree/extension.js"
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
export type ProgressState<T, X extends HandleExtension = never> =
  | { state: "loading"; sources: Record<string, SourceState> }
  | {
      state: "ready"
      handle: ExtendedHandle<T, X>
      sources: Record<string, SourceState>
    }
  | { state: "unavailable"; sources: Record<string, SourceState> }
  | {
      state: "failed"
      error: Error
      sources: Record<string, SourceState>
    }

/** @deprecated Use {@link Repo.query}. Returned by {@link Repo.findWithProgress}. */
export interface DocumentProgress<T, in X extends HandleExtension = never> {
  readonly documentId: DocumentId
  peek(): ProgressState<T, X>
  subscribe(callback: (state: ProgressState<T, X>) => void): () => void
  whenReady(options?: { signal?: AbortSignal }): Promise<ExtendedHandle<T, X>>
}

/** Adapt a query to the deprecated {@link DocumentProgress} shape. */
export function toProgress<T, X extends HandleExtension = never>(
  query: DocumentQuery<T, X>
): DocumentProgress<T, X> {
  const map = (state: QueryState<T, X>): ProgressState<T, X> => {
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
