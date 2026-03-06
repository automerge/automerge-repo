import { SyncState } from "@automerge/automerge/slim"
import { PeerId, DocumentId } from "../types.js"

/** Notify the repo that the sync state has changed  */
export interface SyncStatePayload {
  peerId: PeerId
  documentId: DocumentId
  syncState: SyncState
}

export type DocSyncMetrics =
  | {
      type: "receive-sync-message"
      documentId: DocumentId
      durationMillis: number
      numOps: number
      numChanges: number
      fromPeer: PeerId
    }
  | {
      type: "generate-sync-message"
      documentId: DocumentId
      durationMillis: number
      forPeer: PeerId
    }
  | {
      type: "doc-denied"
      documentId: DocumentId
    }
