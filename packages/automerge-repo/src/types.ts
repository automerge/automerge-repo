export type DocumentId = string & { __documentId: true } // for logging
export type AutomergeUrl = string & { __documentUrl: true } // for opening / linking
export type BinaryDocumentId = Uint8Array & { __binaryDocumentId: true } // for storing / syncing

export type PeerId = string & { __peerId: false }
export type ChannelId = string & { __channelId: false }

export type DistributiveOmit<T, K extends keyof any> = T extends any
  ? Omit<T, K>
  : never
