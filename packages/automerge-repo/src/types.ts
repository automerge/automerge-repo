export type EncodedDocumentId = string & { __encodedDocumentId: true } // for logging
export type AutomergeUrl = string & { __documentUrl: true } // for opening / linking
export type DocumentId = Uint8Array & { __documentId: true } // for storing / syncing

export type PeerId = string & { __peerId: false }
export type ChannelId = string & { __channelId: false }
