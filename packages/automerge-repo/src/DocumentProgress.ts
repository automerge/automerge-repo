import type { DocHandle } from "./types/DocHandle.js"
import type { HandleExtensionSpec } from "./sedimentree/extension.js"
import type { AnyDocType } from "./DocType.js"
import type { AutomergeDocType } from "./automerge/docType.js"
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
export type ProgressState<
  T,
  X extends HandleExtensionSpec = {},
  D extends AnyDocType = AutomergeDocType,
> =
  | { state: "loading"; sources: Record<string, SourceState> }
  | {
      state: "ready"
      handle: DocHandle<T, X, D>
      sources: Record<string, SourceState>
    }
  | { state: "unavailable"; sources: Record<string, SourceState> }
  | {
      state: "failed"
      error: Error
      sources: Record<string, SourceState>
    }

/** @deprecated Use {@link Repo.query}. Returned by {@link Repo.findWithProgress}. */
export interface DocumentProgress<
  T,
  X extends HandleExtensionSpec = {},
  D extends AnyDocType = AutomergeDocType,
> {
  readonly documentId: DocumentId
  peek(): ProgressState<T, X, D>
  subscribe(callback: (state: ProgressState<T, X, D>) => void): () => void
  whenReady(options?: { signal?: AbortSignal }): Promise<DocHandle<T, X, D>>
}

/** Adapt a query to the deprecated {@link DocumentProgress} shape. */
export function toProgress<
  T,
  X extends HandleExtensionSpec = {},
  D extends AnyDocType = AutomergeDocType,
>(query: DocumentQuery<T, X, D>): DocumentProgress<T, X, D> {
  const map = (state: QueryState<T, X, D>): ProgressState<T, X, D> => {
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
