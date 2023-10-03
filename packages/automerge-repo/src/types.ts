/** The ID of a document. Typically you should use a {@link AutomergeUrl} instead.
 */
export type DocumentId = string & { __documentId: true } // for logging

/** A branded string representing a URL for a document
 *
 * @remarks
 * An automerge URL has the form `automerge:<base58 encoded string>`. This
 * type is returned from various routines which validate a url.
 *
 */
export type AutomergeUrl = string & { __documentUrl: true } // for opening / linking

/** A document ID as a Uint8Array instead of a bas58 encoded string. Typically you should use a {@link AutomergeUrl} instead.
 */
export type BinaryDocumentId = Uint8Array & { __binaryDocumentId: true } // for storing / syncing

/** A branded type for peer IDs */
export type PeerId = string & { __peerId: false }

/** A randomly generated string created when the {@link Repo} starts up */
export type SessionId = string & { __SessionId: false }
