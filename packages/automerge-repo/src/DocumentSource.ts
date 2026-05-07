import type { DocumentQuery, SourcePriority } from "./DocumentQuery.js"
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
 * Each source declares a `priority`. This is used to allow sources to wait for
 * other sources to finish processing before making a decision about The
 * availability of a document. For example, the automerge sync protocol source
 * wants to wait for the storage source to have finished loading before sending
 * any "document unavailable" messages to other peers. To achieve this the
 * storage source has a higher priority than the automerge sync protocol source
 * and the automerge sync protocol implementation uses {@link
 * DocumentQuery.shouldDeferAvailability} to determine whether higher priority
 * sources have finished loading before sending unavailability message.
 *
 * Implementing this interface is the primary extension point for adding
 * new sync protocols or data sources.
 */
export interface DocumentSource {
  /** Availability tier this source belongs to. Higher numbers are
   *  consulted earlier; the {@link DocumentQuery} uses this to decide
   *  whether a still-pending lower-priority source should yield to a
   *  higher-priority one.
   * */
  readonly priority: SourcePriority

  /** Called when a new document is registered. The source should call
   *  `query.sourcePending(name)` / `query.sourceUnavailable(name)` as
   *  appropriate to participate in the query's availability tracking. */
  attach(query: DocumentQuery<unknown>): void

  /** Called when a document is removed from the repo. */
  detach(documentId: DocumentId): void

  shareConfigChanged(): void

  /**
   * Optional: drain any pending writes for the given documents (or all
   * documents if `documentIds` is undefined) so they are durable in
   * this source's storage. Sources that don't buffer writes can omit
   * this method.
   *
   * Called by {@link Repo.flush}.
   */
  flush?(documentIds?: DocumentId[]): Promise<void>
}
