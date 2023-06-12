export type DocumentId = string & { __documentId: true }
export type PeerId = string & { __peerId: false }

// Messages

export type MessageEnvelope = {
  senderId: PeerId
  recipientId: PeerId
}

export type SyncMessage = MessageEnvelope & {
  type: "SYNC_MESSAGE"
  payload: {
    documentId: DocumentId
    automergeSyncMessage: Uint8Array
  }
}

export type EphemeralMessage = MessageEnvelope & {
  type: "EPHEMERAL_MESSAGE"
  payload: {
    documentId: DocumentId
    encodedMessage: Uint8Array // CBOR-encoded message created by application
  }
}

export type Message = SyncMessage | EphemeralMessage
export type MessageType = Message["type"]
export type MessagePayload = Message["payload"]
