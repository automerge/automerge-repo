/**
 * A branded document URL, `<scheme>:<base58check encoded ID>[/path][#heads]`. The scheme names
 * the document's type.
 */
export type DocumentUrl<Scheme extends string = string> = string & {
  __documentUrl: true
  readonly __urlScheme?: Scheme
}

/**
 * A URL for an Automerge document, in the form `automerge:<base58check encoded string>`; for
 * example, `automerge:4NMNnkMhL8jXrdJ9jamS58PAVdXu`.
 */
export type AutomergeUrl = DocumentUrl<"automerge"> // for opening / linking

/**
 * The base58check-encoded 32-byte ID of a document, written as just the first
 * 16 bytes when the rest are zero. This follows the `automerge:` protocol
 * prefix in an AutomergeUrl; for example, `4NMNnkMhL8jXrdJ9jamS58PAVdXu`. When
 * recording links to an Automerge document in another Automerge document, you
 * should store a {@link AutomergeUrl} instead.
 */
export type DocumentId = string & { __documentId: true } // for logging

/**
 * The unencoded 32-byte ID; a 16-byte (v2) ID is accepted as input and
 * zero-padded. Typically use an {@link AutomergeUrl} instead.
 */
export type BinaryDocumentId = Uint8Array & { __binaryDocumentId: true } // for storing / syncing

export type AnyDocumentId = DocumentUrl | DocumentId | BinaryDocumentId

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
