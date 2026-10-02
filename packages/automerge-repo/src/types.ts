/**
 * A branded string representing a URL for a document, in the form `automerge:<base58check encoded
 * string>`; for example, `automerge:4NMNnkMhL8jXrdJ9jamS58PAVdXu`.
 */
export type AutomergeUrl = string & { __documentUrl: true } // for opening / linking

/**
 * The base58check-encoded 16- or 32-byte ID of a document. This follows `automerge:`
 * protocol prefix in an AutomergeUrl; for example, `4NMNnkMhL8jXrdJ9jamS58PAVdXu`. When recording
 * links to an Automerge document in another Automerge document, you should store a
 * {@link AutomergeUrl} instead.
 */
export type DocumentId = string & { __documentId: true } // for logging

/** The unencoded 16- or 32-byte ID. Typically use an {@link AutomergeUrl} instead. */
export type BinaryDocumentId = Uint8Array & { __binaryDocumentId: true } // for storing / syncing

/**
 * A UUID encoded as a hex string. As of v1.0, a {@link DocumentId} is stored as a base58-encoded string with a checksum.
 * Support for this format will be removed in a future version.
 */
export type LegacyDocumentId = string & { __legacyDocumentId: true }

export type AnyDocumentId =
  | AutomergeUrl
  | DocumentId
  | BinaryDocumentId
  | LegacyDocumentId

// We need to define our own version of heads because the AutomergeHeads type is not bs58check encoded
export type UrlHeads = string[] & { __automergeUrlHeads: unknown }

/** A branded type for peer IDs */
export type PeerId = string & { __peerId: true }

/** A randomly generated string created when the {@link Repo} starts up */
export type SessionId = string & { __sessionId: true }
