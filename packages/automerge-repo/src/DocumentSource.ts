import type { DocumentQuery } from "./DocumentQuery.js"
import type { DocumentId } from "./types.js"

/**
 * A source of document data. Each source owns its lifecycle on the
 * {@link DocumentQuery} — it calls `sourcePending` when it begins working
 * and `sourceUnavailable` when it determines data is not available.
 *
 * The Repo iterates over all registered sources when a document is created
 * or looked up, calling `attach` on each. When a document is removed,
 * `detach` is called.
 *
 * Implementing this interface is the primary extension point for adding
 * new sync protocols or data sources.
 */
export interface DocumentSource {
  /** Called when a new document is registered. The source should call
   *  `query.sourcePending(name)` / `query.sourceUnavailable(name)` as
   *  appropriate to participate in the query's availability tracking. */
  attach(query: DocumentQuery<unknown>): void

  /** Called when a document is removed from the repo. */
  detach(documentId: DocumentId): void

  shareConfigChanged(): void
}
