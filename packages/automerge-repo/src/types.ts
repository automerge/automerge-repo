/**
 * A branded string representing a URL for a document, in the form `automerge:<base58check encoded
 * string>`; for example, `automerge:4NMNnkMhL8jXrdJ9jamS58PAVdXu`. Legacy 16-byte IDs are accepted
 * in URLs and zero-padded to 32 bytes; use `normalizeDocumentId` to pad them in other forms.
 */
export type AutomergeUrl = string & { __documentUrl: true } // for opening / linking

/**
 * The base58check-encoded 32-byte ID of a document. This follows `automerge:`
 * protocol prefix in an AutomergeUrl; for example, `4NMNnkMhL8jXrdJ9jamS58PAVdXu`. When recording
 * links to an Automerge document in another Automerge document, you should store a
 * {@link AutomergeUrl} instead.
 */
export type DocumentId = string & { __documentId: true } // for logging

/** The unencoded 32-byte ID. Typically use an {@link AutomergeUrl} instead. */
export type BinaryDocumentId = Uint8Array & { __binaryDocumentId: true } // for storing / syncing

export type AnyDocumentId = AutomergeUrl | DocumentId | BinaryDocumentId

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
