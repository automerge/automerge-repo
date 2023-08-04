export type StringDocumentId = string & { __documentId: true }
export type DocumentId = Uint8Array & { __binaryDocumentId: true }
export type PeerId = string & { __peerId: false }
export type ChannelId = string & { __channelId: false }
