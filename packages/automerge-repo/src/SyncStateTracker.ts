import { encodeHeads } from "./AutomergeUrl.js"
import type { DocHandle, SyncInfo } from "./DocHandle.js"
import { headsAreSame } from "./helpers/headsAreSame.js"
import type { PeerMetadata } from "./network/NetworkAdapterInterface.js"
import type { StorageSubsystem } from "./storage/StorageSubsystem.js"
import type { StorageId } from "./storage/types.js"
import type { DocumentId, UrlHeads } from "./types.js"
import type { SyncStatePayload } from "./synchronizer/Synchronizer.js"

export interface SyncStateChange {
  storageId: StorageId
  heads: UrlHeads
  timestamp: number
}

/**
 * Tracks per-document, per-storage-id remote heads. Detects when a peer's
 * heads change, persists sync state, and emits `remote-heads` on the handle.
 *
 * Extracted from the Repo constructor to keep sync-protocol-specific
 * bookkeeping out of the main orchestrator.
 */
export class SyncStateTracker {
  #syncInfo: Record<DocumentId, Record<StorageId, SyncInfo>> = {}

  /**
   * Process a sync-state event from the CollectionSynchronizer.
   *
   * Persists sync state to storage (if applicable) and detects remote head
   * changes. When heads change, emits `remote-heads` on the handle and
   * returns the change info for the caller to forward to
   * RemoteHeadsSubscriptions.
   */
  handleSyncState(
    message: SyncStatePayload,
    peerMetadata: PeerMetadata | undefined,
    handle: DocHandle<any>,
    storageSubsystem?: StorageSubsystem
  ): SyncStateChange | undefined {
    const { storageId, isEphemeral: isEph } = peerMetadata || {}
    if (!storageId) return undefined

    // Persist sync state to storage
    if (storageSubsystem && !isEph) {
      void storageSubsystem.saveSyncState(
        message.documentId,
        storageId,
        message.syncState
      )
    }

    const docSyncInfo = this.#syncInfo[message.documentId] ?? {}
    const heads = docSyncInfo[storageId]?.lastHeads
    const haveHeadsChanged =
      message.syncState.theirHeads &&
      (!heads ||
        !headsAreSame(heads, encodeHeads(message.syncState.theirHeads)))

    if (haveHeadsChanged && message.syncState.theirHeads) {
      const newHeads = encodeHeads(message.syncState.theirHeads)
      const syncInfo: SyncInfo = {
        lastHeads: newHeads,
        lastSyncTimestamp: Date.now(),
      }
      if (!this.#syncInfo[message.documentId]) {
        this.#syncInfo[message.documentId] = {}
      }
      this.#syncInfo[message.documentId][storageId] = syncInfo

      handle.emit("remote-heads", {
        storageId,
        heads: newHeads,
        timestamp: syncInfo.lastSyncTimestamp,
      })

      return {
        storageId,
        heads: newHeads,
        timestamp: syncInfo.lastSyncTimestamp,
      }
    }

    return undefined
  }

  /**
   * Process a gossiped remote-heads-changed event.
   */
  handleRemoteHeadsChanged(
    documentId: DocumentId,
    storageId: StorageId,
    remoteHeads: UrlHeads,
    timestamp: number,
    handle: DocHandle<any>
  ): void {
    if (!this.#syncInfo[documentId]) {
      this.#syncInfo[documentId] = {}
    }
    this.#syncInfo[documentId][storageId] = {
      lastHeads: remoteHeads,
      lastSyncTimestamp: timestamp,
    }
    handle.emit("remote-heads", {
      storageId,
      heads: remoteHeads,
      timestamp,
    })
  }

  /**
   * Clean up state for a document.
   */
  delete(documentId: DocumentId): void {
    delete this.#syncInfo[documentId]
  }
}
