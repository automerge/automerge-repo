/**
 * A branded document URL, `<scheme>:<base58check encoded ID>[<suffix>]`.
 * `Scheme` is the URL scheme (the document's doc type, e.g. `automerge`), for
 * type checks only; by default, any. Everything after the document ID is
 * specific to the doc type.
 */
export type DocumentUrl<Scheme extends string = string> = string & {
  __documentUrl: true
  // A method, so checked loosely both ways: a URL of any doc type (`string`)
  // fits one with a scheme, and back, but two different schemes don't.
  __urlScheme?(scheme: Scheme): void
} // for opening / linking

/**
 * A URL for an Automerge document, in the form `automerge:<base58check encoded
 * string>[/<path>][#<heads>]`; for example,
 * `automerge:4NMNnkMhL8jXrdJ9jamS58PAVdXu`.
 */
export type AutomergeUrl = DocumentUrl<"automerge"> // for opening / linking

/**
 * The base58check-encoded 32-byte ID of a document, written as just the first
 * 16 bytes when the rest are zero. This follows the `<scheme>:` protocol
 * prefix in a {@link DocumentUrl}; for example, `4NMNnkMhL8jXrdJ9jamS58PAVdXu`.
 * When recording links to a document in another document, you should store a
 * {@link DocumentUrl} (or {@link AutomergeUrl}) instead.
 */
export type DocumentId = string & { __documentId: true } // for logging

/**
 * The unencoded 32-byte ID; a 16-byte (v2) ID is accepted as input and
 * zero-padded. Typically use a {@link DocumentUrl} instead.
 */
export type BinaryDocumentId = Uint8Array & { __binaryDocumentId: true } // for storing / syncing

/** Any way of naming a document; with `Scheme`, URLs must be of a document of
 * that doc type, or of any. */
export type AnyDocumentId<Scheme extends string = string> =
  | DocumentUrl<Scheme>
  | DocumentId
  | BinaryDocumentId

// We need to define our own version of heads because the AutomergeHeads type is not bs58check encoded
export type UrlHeads = string[] & { __automergeUrlHeads: unknown }

/**
 * The identity a backend authenticated for a peer, e.g. a signer's key. A peer
 * may act for several Repos (tabs behind one signer, or one backend hosted for
 * many), and may be reported differently to different observers.
 */
export type PeerId = string & { __peerId: true }

/**
 * Identifies one Repo instance: new on each construction unless configured,
 * and chosen by the Repo itself, so not verified by anyone else. A peer
 * ({@link PeerId}) may act for several Repos.
 */
export type RepoId = string & { __repoId: true }

/** The last heads a remote peer advertised, and when. */
export type SyncInfo = {
  lastHeads: UrlHeads
  lastSyncTimestamp: number
}
