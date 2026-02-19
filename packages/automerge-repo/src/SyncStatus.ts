import { Heads } from "@automerge/automerge"
import { NetworkAdapterInterface } from "./network/NetworkAdapterInterface.js"
import { DocumentId, PeerId } from "./types.js"
import { MessageContents, RepoMessage } from "./network/messages.js"

export type ConnectionStatus = {
  peerId: PeerId
  adapter: NetworkAdapterInterface
  state: "connected" | "disconnected" | "connecting"
  events: ConnectionEvent[]
}

export type ConnectionEvent =
  | { type: "connected"; timestamp: Date }
  | { type: "disconnected"; timestamp: Date }
  | { type: "connecting"; timestamp: Date }
  | {
      type: "message_sent"
      timestamp: Date
      documentId?: DocumentId
      message: any
    }
  | {
      type: "message_received"
      from: PeerId
      timestamp: Date
      documentId?: DocumentId
      message: any
    }

export type DocSyncStatus = {
  docId: DocumentId
  connections: DocConnectionStatus[]
}

export type PeerDocumentState = "unknown" | "has" | "unavailable" | "wants"

export type DocConnectionStatus = {
  peerId: PeerId
  adapter: NetworkAdapterInterface | null
  state: PeerDocumentState
  events: DocConnectionEvent[]
  /** Heads we believe the peer currently has (null when unknown or after sync completes) */
  theirHeads: Heads | null
  /** Heads both sides have confirmed they share */
  sharedHeads: Heads | null
}

export type DocConnectionEvent =
  | {
      type: "message_sent"
      timestamp: Date
      message: MessageContents
    }
  | {
      type: "message_received"
      senderId: PeerId
      timestamp: Date
      message: RepoMessage
    }
