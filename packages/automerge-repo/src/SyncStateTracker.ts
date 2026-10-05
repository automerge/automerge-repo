import { encodeHeads } from "./AutomergeUrl.js"
import type { DocHandle, SyncInfo } from "./DocHandle.js"
import { headsAreSame } from "./helpers/headsAreSame.js"
import { makeLogger } from "./Logger.js"
import type { PeerMetadata } from "./network/NetworkAdapterInterface.js"
import type { StorageSubsystem } from "./storage/StorageSubsystem.js"
import type { StorageId } from "./storage/types.js"
import type { DocumentId, UrlHeads } from "./types.js"
import type { SyncStatePayload } from "./synchronizer/Synchronizer.js"
import { asyncThrottle } from "./helpers/throttle.js"
import { semaphore, type Limit } from "./helpers/semaphore.js"

/**
 * Default cap on concurrent sync-state writes. Saves are throttled per
 * document, so a peer syncing many documents at once would otherwise issue one
 * storage write per document together.
 */
export const DEFAULT_SYNC_STATE_SAVE_CONCURRENCY = 20

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
  #storage: StorageSubsystem | undefined
  #saveDebounceRate: number
  /**
   * Throttled sync-state save handlers per document and storage id, keyed
   * weakly by the handle so entries go away with it. asyncThrottle runs only
   * the latest call's arguments, so a handler shared across documents would
   * drop all but the last document's save.
   */
  #throttledSaveSyncStateHandlers = new WeakMap<
    DocHandle<any>,
    Record<StorageId, (payload: SyncStatePayload) => Promise<void>>
  >()
  /** Bounds concurrent sync-state writes across all documents and peers. */
  #saveSyncStateLimit: Limit
  #log = makeLogger("automerge-repo:sync-state-tracker")

  constructor(
    storage: StorageSubsystem | undefined,
    saveDebounceRate: number,
    saveConcurrency: number = DEFAULT_SYNC_STATE_SAVE_CONCURRENCY
  ) {
    this.#storage = storage
    this.#saveDebounceRate = saveDebounceRate
    this.#saveSyncStateLimit = semaphore(saveConcurrency)
  }

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
    handle: DocHandle<any>
  ): SyncStateChange | undefined {
    const { storageId, isEphemeral: isEph } = peerMetadata || {}
    if (!storageId) return undefined

    // Persist sync state to storage
    this.#saveSyncState(message, storageId, !!isEph, handle)

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
   * Look up the latest known sync info (heads + timestamp) for a
   * document/storage pair. Returns undefined if we have not received sync
   * info from that peer.
   */
  getSyncInfo(
    documentId: DocumentId,
    storageId: StorageId
  ): SyncInfo | undefined {
    return this.#syncInfo[documentId]?.[storageId]
  }

  /**
   * Clean up state for a document.
   */
  delete(documentId: DocumentId): void {
    delete this.#syncInfo[documentId]
  }

  /** saves sync state throttled per document and storage id, if a peer doesn't have a storage id it's sync state is not persisted */
  #saveSyncState(
    payload: SyncStatePayload,
    storageId: StorageId | undefined,
    isEphemeral: boolean,
    handle: DocHandle<any>
  ) {
    if (!this.#storage) {
      return
    }

    if (!storageId || isEphemeral) {
      return
    }

    let handlers = this.#throttledSaveSyncStateHandlers.get(handle)
    if (!handlers) {
      handlers = {}
      this.#throttledSaveSyncStateHandlers.set(handle, handlers)
    }
    let handler = handlers[storageId]
    if (!handler) {
      handler = handlers[storageId] = asyncThrottle(
        async ({ documentId, syncState }: SyncStatePayload) => {
          try {
            await this.#saveSyncStateLimit(() =>
              this.#storage!.saveSyncState(documentId, storageId, syncState)
            )
          } catch (err) {
            // Fire-and-forget (the result is discarded below): catch and log a
            // failed write instead of letting it surface as an unhandled
            // rejection. Sync state is re-derived from the next sync exchange,
            // so a dropped save is recoverable.
            this.#log.error(
              `Error saving sync state for ${documentId} to ${storageId}`,
              err
            )
          }
        },
        this.#saveDebounceRate
      )
    }

    void handler(payload)
  }
}
