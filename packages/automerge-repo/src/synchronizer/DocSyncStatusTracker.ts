import { next as A } from "@automerge/automerge/slim"
import { decode } from "cbor-x"
import { EventEmitter } from "eventemitter3"
import { DocumentId, PeerId } from "../types.js"
import { DocConnectionEvent, DocSyncStatus } from "../SyncStatus.js"
import type { NetworkAdapterInterface } from "../network/NetworkAdapterInterface.js"

const MAX_EVENTS_PER_PEER = 100

export type PeerDocumentState = "unknown" | "has" | "unavailable" | "wants"

export interface DocSyncStatusTrackerEvents {
  "sync-status-change": (arg: { documentId: DocumentId }) => void
}

/**
 * Tracks per-peer sync status and event history for a single document.
 * Designed to observe a DocSynchronizer without modifying its core logic.
 */
export class DocSyncStatusTracker extends EventEmitter<DocSyncStatusTrackerEvents> {
  #documentId: DocumentId
  #peerEvents: Record<PeerId, DocConnectionEvent[]> = {}
  #getAdapterForPeer?: (peerId: PeerId) => NetworkAdapterInterface | undefined

  constructor(
    documentId: DocumentId,
    getAdapterForPeer?: (peerId: PeerId) => NetworkAdapterInterface | undefined
  ) {
    super()
    this.#documentId = documentId
    this.#getAdapterForPeer = getAdapterForPeer
  }

  #append(peerId: PeerId, event: DocConnectionEvent) {
    if (!this.#peerEvents[peerId]) {
      this.#peerEvents[peerId] = []
    }
    this.#peerEvents[peerId].push(event)
    if (this.#peerEvents[peerId].length > MAX_EVENTS_PER_PEER) {
      this.#peerEvents[peerId] = this.#peerEvents[peerId].slice(
        -MAX_EVENTS_PER_PEER
      )
    }
    this.#emitChange()
  }

  #tryDecodeCbor(data: Uint8Array): any {
    try {
      return decode(new Uint8Array(data))
    } catch {
      return data
    }
  }

  #emitChange() {
    this.emit("sync-status-change", { documentId: this.#documentId })
  }

  // -- Notification methods called by DocSynchronizer --

  peerAdded() {
    this.#emitChange()
  }

  peerRemoved(peerId: PeerId) {
    delete this.#peerEvents[peerId]
    this.#emitChange()
  }

  syncStateChanged() {
    this.#emitChange()
  }

  statusBecameUnavailable() {
    this.#emitChange()
  }

  messageSent(peerId: PeerId, data: Uint8Array) {
    this.#append(peerId, {
      type: "message_sent",
      timestamp: new Date(),
      message: this.#tryDecodeCbor(data),
    })
  }

  syncMessageReceived(senderId: PeerId, data: Uint8Array) {
    this.#append(senderId, {
      type: "message_received",
      from: senderId,
      timestamp: new Date(),
      message: this.#tryDecodeCbor(data),
    })
  }

  docUnavailableReceived(senderId: PeerId) {
    this.#append(senderId, {
      type: "message_received",
      from: senderId,
      timestamp: new Date(),
      message: { type: "doc-unavailable" },
    })
  }

  // -- Query --

  syncStatus(
    peers: PeerId[],
    peerDocumentStatuses: Record<PeerId, PeerDocumentState>,
    syncStates: Record<PeerId, A.SyncState>
  ): DocSyncStatus {
    return {
      docId: this.#documentId,
      connections: peers.map(peerId => {
        const syncState = syncStates[peerId]
        let theirHeads = null
        let sharedHeads = null
        if (syncState) {
          const decoded = A.decodeSyncState(A.encodeSyncState(syncState))
          if (decoded.theirHeads && decoded.theirHeads.length > 0) {
            theirHeads = decoded.theirHeads
          }
          if (decoded.sharedHeads && decoded.sharedHeads.length > 0) {
            sharedHeads = decoded.sharedHeads
          }
        }

        return {
          peerId,
          adapter: this.#getAdapterForPeer?.(peerId) ?? null,
          state: peerDocumentStatuses[peerId] ?? "unknown",
          events: this.#peerEvents[peerId] ?? [],
          theirHeads,
          sharedHeads,
        }
      }),
    }
  }
}
