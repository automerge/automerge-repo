import { encodeHeads } from "./AutomergeUrl.js"
import type { DocHandle, SyncInfo } from "./DocHandle.js"
import { headsAreSame } from "./helpers/headsAreSame.js"
import { makeLogger } from "./Logger.js"
import type { PeerMetadata } from "./network/NetworkAdapterInterface.js"
import type { StorageSubsystem } from "./storage/StorageSubsystem.js"
import type { StorageId } from "./storage/types.js"
import type { UrlHeads } from "./types.js"
import type { SyncStatePayload } from "./synchronizer/Synchronizer.js"
import { asyncThrottle } from "./helpers/throttle.js"

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
  /**
   * Per-document sync info, keyed weakly by the root handle, which lives
   * exactly as long as its document - so entries die with the document
   * and the GC path needs no explicit cleanup.
   */
  #syncInfo = new WeakMap<DocHandle<any>, Record<StorageId, SyncInfo>>()
  #storage: StorageSubsystem | undefined
  #saveDebounceRate: number
  /**
   * Per-document, per-storage-id throttled sync-state save handlers, keyed
   * weakly by the root handle so entries die with the document. Keyed per
   * document so one document's rapid updates can't coalesce away another
   * document's save (asyncThrottle runs only the latest call's args).
   */
  #throttledSaveSyncStateHandlers = new WeakMap<
    DocHandle<any>,
    Record<StorageId, (payload: SyncStatePayload) => Promise<void>>
  >()
  #log = makeLogger("automerge-repo:sync-state-tracker")

  constructor(storage: StorageSubsystem | undefined, saveDebounceRate: number) {
    this.#storage = storage
    this.#saveDebounceRate = saveDebounceRate
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

    let docSyncInfo = this.#syncInfo.get(handle)
    const heads = docSyncInfo?.[storageId]?.lastHeads
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
      if (!docSyncInfo) {
        docSyncInfo = {}
        this.#syncInfo.set(handle, docSyncInfo)
      }
      docSyncInfo[storageId] = syncInfo

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
    storageId: StorageId,
    remoteHeads: UrlHeads,
    timestamp: number,
    handle: DocHandle<any>
  ): void {
    let docSyncInfo = this.#syncInfo.get(handle)
    if (!docSyncInfo) {
      docSyncInfo = {}
      this.#syncInfo.set(handle, docSyncInfo)
    }
    docSyncInfo[storageId] = {
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
    handle: DocHandle<any>,
    storageId: StorageId
  ): SyncInfo | undefined {
    return this.#syncInfo.get(handle)?.[storageId]
  }

  /**
   * Clean up state for a document (explicit teardown; the GC path cleans
   * up on its own through the WeakMap).
   */
  delete(handle: DocHandle<any>): void {
    this.#syncInfo.delete(handle)
    this.#throttledSaveSyncStateHandlers.delete(handle)
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
            await this.#storage!.saveSyncState(documentId, storageId, syncState)
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
