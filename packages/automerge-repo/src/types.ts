export type DocumentId = string & { __documentId: true }
export type PeerId = string & { __peerId: false }

// Messages

export type HelloMessage = {
  type: "HELLO"
  senderId: PeerId
}

export type SyncMessage = {
  type: "SYNC"
  senderId: PeerId
  recipientId: PeerId
  payload: {
    documentId: DocumentId
    syncPayload: Uint8Array
  }
}

export type EphemeralMessage<T = unknown> = {
  type: "EPHEMERAL"
  senderId: PeerId
  payload: T
}

// export type AuthMessage = {
//   type: "AUTH"
//   senderId: PeerId
//   recipientId: PeerId
//   payload: {
//     shareId: ShareId
//     authPayload: any
//   }
// }

export type DocumentNotFoundMessage = {
  type: "DOCUMENT_NOT_FOUND"
  senderId: PeerId

  payload: {
    documentId: DocumentId
  }
}

export type Message = SyncMessage | EphemeralMessage
export type MessageType = Message["type"]
export type MessagePayload = Message["payload"]
