export type DocumentId = string & { __documentId: true }
export type PeerId = string & { __peerId: false }

// Messages

export type MessageEnvelope = {
  senderId: PeerId
  recipientId: PeerId
}

export type HelloMessage = MessageEnvelope & {
  type: "HELLO"
}

export type SyncMessage = MessageEnvelope & {
  type: "SYNC"
  payload: {
    documentId: DocumentId
    syncPayload: Uint8Array
  }
}

export type EphemeralMessage = MessageEnvelope & {
  type: "EPHEMERAL"
  payload: {
    documentId: DocumentId
    encodedMessage: Uint8Array // CBOR-encoded message created by application
  }
}

// export type AuthMessage = MessageEnvelope & {
//   type: "AUTH"
//   payload: {
//     shareId: ShareId
//     authPayload: any
//   }
// }

export type DocumentNotFoundMessage = MessageEnvelope & {
  type: "DOCUMENT_NOT_FOUND"
  payload: {
    documentId: DocumentId
  }
}

export type GoodbyeMessage = MessageEnvelope & {
  type: "GOODBYE"
}

export type Message = SyncMessage | EphemeralMessage
export type MessageType = Message["type"]
export type MessagePayload = Message["payload"]
