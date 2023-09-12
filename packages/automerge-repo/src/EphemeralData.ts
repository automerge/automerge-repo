import { DocumentId, PeerId } from "./index.js"
import { EphemeralMessageContents } from "./network/messages.js"

// types
/** A randomly generated string created when the {@link Repo} starts up */
export type SessionId = string & { __SessionId: false }

export interface EphemeralDataPayload {
  documentId: DocumentId
  peerId: PeerId
  data: { peerId: PeerId; documentId: DocumentId; data: unknown }
}

export type EphemeralDataMessageEvents = {
  message: (event: EphemeralMessageContents) => void
  data: (event: EphemeralDataPayload) => void
}
