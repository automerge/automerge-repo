import { DocHandle } from "./DocHandle.js"
import { StorageAdapter, NetworkAdapter } from "./index.js"

/**
 * A branded string representing a URL for a document, in the form `automerge:<base58check encoded
 * string>`; for example, `automerge:4NMNnkMhL8jXrdJ9jamS58PAVdXu`.
 */
export type AutomergeUrl = string & { __documentUrl: true } // for opening / linking

/**
 * The base58check-encoded UUID of a document. This is the string following the `automerge:`
 * protocol prefix in an AutomergeUrl; for example, `4NMNnkMhL8jXrdJ9jamS58PAVdXu`. When recording
 * links to an Automerge document in another Automerge document, you should store a
 * {@link AutomergeUrl} instead.
 */
export type DocumentId = string & { __documentId: true } // for logging

/** The unencoded UUID of a document. Typically you should use a {@link AutomergeUrl} instead. */
export type BinaryDocumentId = Uint8Array & { __binaryDocumentId: true } // for storing / syncing

/**
 * A UUID encoded as a hex string. As of v1.0, a {@link DocumentID} is stored as a base58-encoded string with a checksum.
 * Support for this format will be removed in a future version.
 */
export type LegacyDocumentId = string & { __legacyDocumentId: true }

export type AnyDocumentId =
  | AutomergeUrl
  | DocumentId
  | BinaryDocumentId
  | LegacyDocumentId

/** A branded type for peer IDs */
export type PeerId = string & { __peerId: true }

/** A randomly generated string created when the {@link Repo} starts up */
export type SessionId = string & { __SessionId: true }

export interface RepoConfig {
  /** Our unique identifier */
  peerId?: PeerId

  /** A storage adapter can be provided, or not */
  storage?: StorageAdapter

  /** One or more network adapters must be provided */
  network: NetworkAdapter[]

  /**
   * Normal peers typically share generously with everyone (meaning we sync all our documents with
   * all peers). A server only syncs documents that a peer explicitly requests by ID.
   */
  sharePolicy?: SharePolicy
}

/** A function that determines whether we should share a document with a peer
 *
 * @remarks
 * This function is called by the {@link Repo} every time a new document is created
 * or discovered (such as when another peer starts syncing with us). If this
 * function returns `true` then the {@link Repo} will begin sharing the new
 * document with the peer given by `peerId`.
 * */
export type SharePolicy = (
  peerId: PeerId,
  documentId?: DocumentId
) => Promise<boolean>

// events & payloads

export interface RepoEvents {
  /** A new document was created or discovered */
  document: (arg: DocumentPayload) => void

  /** A document was deleted */
  "delete-document": (arg: DeleteDocumentPayload) => void

  /** A document was marked as unavailable (we don't have it and none of our peers have it) */
  "unavailable-document": (arg: DeleteDocumentPayload) => void
}

export interface DocumentPayload {
  handle: DocHandle<any>
  isNew: boolean
}

export interface DeleteDocumentPayload {
  documentId: DocumentId
}
