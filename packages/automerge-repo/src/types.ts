export type DocumentId = string & { __documentId: true }
export type PeerId = string & { __peerId: false }
export type ChannelId = string & { __channelId: false }

// Messages

export type SyncMessage = {
  type: "SYNC_MESSAGE"
  senderId: PeerId
  recipientId: PeerId
  documentId: DocumentId
  payload: Uint8Array // Automerge binary sync message
}

export type EphemeralMessage = {
  type: "EPHEMERAL_MESSAGE"
  senderId: PeerId
  documentId: DocumentId
  payload: Uint8Array // CBOR-encoded payload
}

export type Message = SyncMessage | EphemeralMessage
