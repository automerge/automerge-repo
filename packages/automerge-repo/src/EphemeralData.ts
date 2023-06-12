import { decode, encode } from "cbor-x"
import EventEmitter from "eventemitter3"
import { DocumentId, EphemeralMessage, PeerId } from "./index.js"

/**
 * EphemeralData provides a mechanism to broadcast short-lived data — cursor positions, presence,
 * heartbeats, etc. — that is useful in the moment but not worth persisting.
 */
export class EphemeralData extends EventEmitter<EphemeralDataMessageEvents> {
  /** Encodes an ephemeral message and emits a `message` event so the network subsystem will broadcast it */
  broadcast(documentId: DocumentId, message: any) {
    const encodedMessage = encode(message)
    this.emit("sending", {
      documentId,
      encodedMessage,
    })
  }

  /** Decodes an ephemeral message and emits a `data` event to alert the application */
  receive(message: EphemeralMessage) {
    const { senderId, payload } = message
    const { documentId, encodedMessage } = payload
    const decodedMessage = decode(encodedMessage)
    this.emit("receiving", { documentId, senderId, message: decodedMessage })
  }
}

// types

export type EphemeralDataMessageEvents = {
  // we raise this event when we're sending a message
  sending: (payload: OutgoingPayload) => void
  // we raise this event when we've received and decoded a message
  receiving: (payload: IncomingPayload) => void
}

// sending
export type OutgoingPayload = {
  documentId: DocumentId
  encodedMessage: Uint8Array
}

// receiving
export interface IncomingPayload {
  documentId: DocumentId
  senderId: PeerId
  message: any // decoded
}
