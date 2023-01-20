export type DocumentId = string & { __documentId: true }
export type PeerId = string & { __peerId: false }
export type ChannelId = string & { __channelId: false }
