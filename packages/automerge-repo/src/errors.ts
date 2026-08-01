import type { DocumentId } from "./types.js"

/**
 * Thrown when a wait for a document gives up because every registered source
 * has reported that it cannot provide the document.
 *
 * @remarks
 * Unavailability is not necessarily permanent: a source may return to `pending`
 * when circumstances change, for example when a peer that holds the document
 * connects.
 *
 * This error means every source reached a *determinate* negative. A source that
 * could not complete the read settles as {@link DocumentLoadFailedError}
 * instead.
 *
 * Note that the sync protocol does not distinguish these failure modes, so
 * peers may claim a document unavailable even if they failed to check.
 */
export class DocumentUnavailableError extends Error {
  readonly documentId: DocumentId

  constructor(documentId: DocumentId) {
    super(`Document ${documentId} is unavailable`)
    this.name = "DocumentUnavailableError"
    this.documentId = documentId
  }
}

/**
 * Thrown when every source has given up on a document and at least one of them
 * could not determine whether it exists: a failed storage read, network
 * adapters that never came up.
 *
 * @remarks
 * Distinct from {@link DocumentUnavailableError}, which asserts a determinate
 * negative. Here the document's absence was never established.
 *
 * Extends {@link !AggregateError}: the per-source errors are also exposed as
 * `errors`.
 *
 * {@link DocumentLoadFailedError.causes} is those same errors keyed by source
 * name (`"storage"`, `"automerge-sync"`), because more than one source can fail
 * for unrelated reasons.
 */
export class DocumentLoadFailedError extends AggregateError {
  readonly documentId: DocumentId

  /** Why each source could not determine availability, by source name. */
  declare readonly causes: Record<string, Error>

  constructor(documentId: DocumentId, causes: Record<string, Error>) {
    super(
      Object.values(causes),
      DocumentLoadFailedError.#summary(documentId, causes)
    )
    this.name = "DocumentLoadFailedError"
    this.documentId = documentId
    // `causes` is the same errors as `errors` (from AggregateError), just keyed
    // by source. Keep it non-enumerable so a structured logger serializes
    // `errors` once.
    Object.defineProperty(this, "causes", {
      value: Object.freeze({ ...causes }),
      enumerable: false,
    })
  }

  static #summary(
    documentId: DocumentId,
    causes: Record<string, Error>
  ): string {
    const detail = Object.entries(causes)
      .map(([source, cause]) => `${source}: ${cause.message}`)
      .join("; ")
    return `Document ${documentId} could not be loaded (${detail})`
  }
}

/**
 * Thrown when a document has been deleted locally, via {@link Repo.delete}.
 *
 * @remarks
 * A deleted document surfaces through the same `failed` query state as a
 * genuine fault (a storage error, say), but the two call for opposite
 * responses: deletion is an intentional, known-terminal outcome, whereas a
 * fault may be transient and retryable. Catching this type distinguishes them
 * without matching on message text.
 */
export class DocumentDeletedError extends Error {
  readonly documentId: DocumentId

  constructor(documentId: DocumentId) {
    super(`Document ${documentId} was deleted`)
    this.name = "DocumentDeletedError"
    this.documentId = documentId
  }
}
