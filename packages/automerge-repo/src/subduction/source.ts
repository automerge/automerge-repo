import * as Automerge from "@automerge/automerge/slim"
import {
  CommitId,
  SedimentreeId,
  Subduction,
  SedimentreeAutomerge,
  FragmentStateStore,
  HashMetric,
  Topic,
  setSubductionLogLevel,
  type FragmentRequested,
  type Policy,
} from "@automerge/automerge-subduction/slim"
import { DocumentSource } from "../DocumentSource.js"
import { DocumentQuery } from "../DocumentQuery.js"
import { DocumentId, PeerId } from "../types.js"
import { automergeMeta, toSedimentreeId, toDocumentId } from "./helpers.js"
import { DocHandle, NetworkAdapterInterface } from "../index.js"
import { ConnectionManager } from "./ConnectionManager.js"
import type { StorageId } from "../storage/types.js"
import type { UrlHeads } from "../types.js"
import { throttle, type ThrottledFunction } from "../helpers/throttle.js"
import { HashRing } from "../helpers/HashRing.js"
import debug from "debug"
import { SubductionStorageBridge } from "./storage.js"
import { SubductionConnections } from "./SubductionConnections.js"
import { SyncScheduler } from "./SyncScheduler.js"
import { AdapterConnections } from "./AdapterConnections.js"

export type { OnHealExhausted } from "./SyncScheduler.js"

const RECENTLY_SAVED_CACHE_SIZE = 256

// ── Per-sedimentree state ───────────────────────────────────────────────
//
// `initializing`: suppress individual commit-saved events. The handle
//     is populated via a batch getBlobs + loadIncremental once a sync
//     has succeeded, preventing whenReady() from resolving on partial
//     data. Covers hydration, initial sync, and the subsequent blob load.
//
// `running`: commit-saved events flow through to the handle directly
//     for live subscription pushes.

type SedimentreeSyncState = "initializing" | "running"
type SyncResult = "succeeded" | "no-peers" | "all-failed"

interface SedimentreeEntry {
  syncState: SedimentreeSyncState
  query: DocumentQuery<unknown>
  handle: DocHandle<unknown>
  sedimentreeId: SedimentreeId

  // Initialization tracking
  syncInFlight: boolean
  lastSyncResult: SyncResult | null
  lastSyncGeneration: number
  blobLoadInFlight: boolean
  needsResync: boolean
  blobRetries: number

  // Save tracking
  lastSavedHeads: Set<string>
  recentlySavedHashes: HashRing
  flushSave: ThrottledFunction<() => void>
  /** Resolves when any in-progress `#save` completes. */
  saveSettled: Promise<void>

  // Fragment processing — decoupled from saves, deduped by head+depth
  pendingFragmentRequests: Map<string, FragmentRequested>
  processingFragments: boolean
}

/** Callback for remote heads changes from subduction peers. */
export type OnRemoteHeadsChanged = (
  documentId: DocumentId,
  storageId: StorageId,
  heads: UrlHeads
) => void

/** Callback for inbound ephemeral messages from subduction peers. */
export type OnEphemeral = (
  sedimentreeId: SedimentreeId,
  senderId: { toString(): string },
  payload: Uint8Array
) => void

export interface SubductionSourceOptions {
  peerId: PeerId
  storage: SubductionStorageBridge
  signer: any
  websocketEndpoints: string[]
  adapters: {
    adapter: NetworkAdapterInterface
    serviceName: string
    role?: "connect" | "accept"
  }[]
  onRemoteHeadsChanged?: OnRemoteHeadsChanged
  onEphemeral?: OnEphemeral
  onHealExhausted?: (documentId: DocumentId) => void

  /**
   * Called when subduction receives data for a document it doesn't have
   * an entry for. The Repo creates the query/handle and calls attach.
   */
  ensureHandle: (documentId: DocumentId) => void

  policy?: Policy

  /**
   * Interval in ms for per-document periodic sync. Each open document is
   * synced individually (skipping those already in heal-backoff).
   * Set to 0 to disable. Default: 30_000 (30s).
   */
  periodicSyncInterval?: number

  /**
   * Interval in ms for a full batch sync across all sedimentrees.
   * On success, all heal state is reset.
   * Set to 0 to disable. Default: 300_000 (5 min).
   */
  batchSyncInterval?: number
}

export class SubductionSource implements DocumentSource {
  #subduction: Promise<Subduction>
  #storage: SubductionStorageBridge
  #entries = new Map<string, SedimentreeEntry>()
  #fragmentStateStore: FragmentStateStore = new FragmentStateStore()
  #log: debug.Debugger
  #connectionManagers: ConnectionManager[] = []
  #scheduler: SyncScheduler
  #ensureHandle: (documentId: DocumentId) => void

  constructor({
    peerId,
    storage,
    signer,
    websocketEndpoints,
    adapters,
    onRemoteHeadsChanged,
    onEphemeral,
    onHealExhausted,
    ensureHandle,
    policy,
    periodicSyncInterval = 30_000,
    batchSyncInterval = 300_000,
  }: SubductionSourceOptions) {
    // Default to "warn" so the Rust side is quiet. When the debug npm module
    // has subduction namespaces enabled (via localStorage.debug), open the
    // Rust tracing filter so the messages actually reach the JS logger.
    // In Service Worker contexts, localStorage is unavailable — check
    // globalThis.__SUBDUCTION_DEBUG as a fallback.
    const subductionDebugRequested =
      (typeof localStorage !== "undefined" &&
        /subduction/i.test(localStorage.getItem("debug") ?? "")) ||
      !!(globalThis as any).__SUBDUCTION_DEBUG
    try {
      setSubductionLogLevel(subductionDebugRequested ? "debug" : "warn")
    } catch {
      // Wasm module not yet initialized
    }
    this.#log = debug(`automerge-repo:subduction(${peerId})`)
    this.#storage = storage
    this.#ensureHandle = ensureHandle

    const onRemoteHeads = onRemoteHeadsChanged
      ? (
          sedimentreeId: SedimentreeId,
          remotePeerId: { toString(): string },
          heads: Array<{ toHexString(): string }>
        ) => {
          const documentId = toDocumentId(sedimentreeId)
          const storageId = remotePeerId.toString() as StorageId
          const urlHeads = heads.map(h => h.toHexString()) as UrlHeads
          onRemoteHeadsChanged(documentId, storageId, urlHeads)
        }
      : undefined

    if (websocketEndpoints.length > 0 || adapters.length > 0) {
      // Full hydration: load persisted sedimentrees from storage so
      // fingerprint-based sync can resume where it left off.
      this.#log("starting hydrate...")
      const hydrateStart = performance.now()
      this.#subduction = Subduction.hydrate(
        signer,
        storage,
        undefined, // service_name
        undefined, // hash_metric_override
        undefined, // max_pending_blob_requests
        policy,
        undefined, // ephemeral_policy
        onRemoteHeads,
        onEphemeral
      ).then(s => {
        this.#log(
          `hydrate complete in ${(performance.now() - hydrateStart).toFixed(
            0
          )}ms`
        )
        return s
      })
    } else {
      // No endpoints — skip hydration to avoid hundreds of IndexedDB
      // transactions that would compete with the service worker's real
      // hydration on the same database.
      this.#log("no endpoints, skipping hydrate")
      this.#subduction = Promise.resolve(
        new Subduction(
          signer,
          storage,
          undefined, // service_name
          undefined, // hash_metric_override
          undefined, // max_pending_blob_requests
          policy,
          undefined, // ephemeral_policy
          onRemoteHeads,
          onEphemeral
        )
      )
    }

    // ── Connection managers ─────────────────────────────────────────
    const wsConnections = new SubductionConnections(this.#subduction)
    for (const url of websocketEndpoints) {
      wsConnections.manageConnection(url)
    }
    this.#connectionManagers.push(wsConnections)

    const adapterConnections = new AdapterConnections(this.#subduction, peerId)
    for (const { adapter, serviceName, role } of adapters) {
      adapterConnections.addAdapter(adapter, serviceName, role ?? "connect")
    }
    this.#connectionManagers.push(adapterConnections)

    for (const mgr of this.#connectionManagers) {
      mgr.onChange(() => this.#recompute())
    }

    this.#storage.on("commit-saved", this.#handleDataFound.bind(this))
    this.#storage.on("fragment-saved", this.#handleDataFound.bind(this))
    this.#storage.on("sedimentree-id-saved", this.#handleSedimentreeIdSaved.bind(this))

    // ── Sync scheduler ────────────────────────────────────────────────
    this.#scheduler = new SyncScheduler({
      subduction: this.#subduction,
      log: this.#log,
      getActiveSedimentreeIds: () =>
        Array.from(this.#entries.values()).map(e => e.sedimentreeId),
      onSyncDataReceived: async (sedimentreeId, subduction) => {
        const entry = this.#entries.get(sedimentreeId.toString())
        if (entry) {
          await this.#loadBlobsIntoHandle(entry, subduction)
        }
      },
      onHealExhausted,
      periodicSyncInterval,
      batchSyncInterval,
    })
  }

  #anyConnectionManagerConnecting(): boolean {
    return this.#connectionManagers.some(mgr => mgr.isConnecting())
  }

  #connectionGeneration(): number {
    let total = 0
    for (const mgr of this.#connectionManagers) {
      total += mgr.generation()
    }
    return total
  }

  // ── Storage events ──────────────────────────────────────────────────

  #handleDataFound(id: SedimentreeId, _commitId: CommitId, blob: Uint8Array) {
    const entry = this.#entries.get(id.toString())
    if (!entry) {
      const documentId = toDocumentId(id)
      this.#log(`ensureHandle for unknown sedimentree ${id.toString().slice(0, 8)} (docId=${documentId.slice(0, 8)})`)
      this.#ensureHandle(documentId)
      return
    }

    // During "initializing", let #loadBlobsAndTransition handle the
    // complete blob load atomically. Applying individual commits here
    // would cause premature "ready" transitions (the handle gets heads > 0
    // from a partial load, triggering DocumentQuery to resolve whenReady()
    // before the full document is available).
    if (entry.syncState === "initializing") return

    this.#log(`handleDataFound ${id}`)
    entry.handle.update(d => Automerge.loadIncremental(d, blob))

    // If the query was previously marked unavailable (e.g. sync completed
    // before data arrived), re-trigger a recompute so the query detects the
    // newly-loaded heads and transitions to "ready".
    entry.query.sourcePending("subduction")
  }

  #handleSedimentreeIdSaved(id: SedimentreeId) {
    if (this.#entries.has(id.toString())) return
    const documentId = toDocumentId(id)
    this.#log(`sedimentree-id-saved: ensureHandle for ${id.toString().slice(0, 8)} (docId=${documentId.slice(0, 8)})`)
    this.#ensureHandle(documentId)
  }

  // ── Attach / detach ─────────────────────────────────────────────────

  attach(query: DocumentQuery<unknown>): void {
    const sid = toSedimentreeId(query.documentId)
    const sidStr = sid.toString()
    if (this.#entries.has(sidStr)) return

    let resolveSaveSettled!: () => void
    const saveSettled = new Promise<void>(r => {
      resolveSaveSettled = r
    })
    // Resolve immediately — no save is in-progress yet.
    resolveSaveSettled()

    const throttledSave = throttle(() => {
      const entry = this.#entries.get(sidStr)
      if (!entry) return
      const doc = entry.handle.doc()
      if (!doc) return
      this.#save(entry, doc)
    }, 100)

    this.#entries.set(sidStr, {
      syncState: "initializing",
      query,
      handle: query.handle,
      sedimentreeId: sid,
      syncInFlight: false,
      lastSyncResult: null,
      lastSyncGeneration: -1,
      blobLoadInFlight: false,
      blobRetries: 0,
      needsResync: false,
      lastSavedHeads: new Set(),
      recentlySavedHashes: new HashRing(RECENTLY_SAVED_CACHE_SIZE),
      flushSave: throttledSave,
      saveSettled,
      pendingFragmentRequests: new Map(),
      processingFragments: false,
    })

    query.sourcePending("subduction")

    query.handle.on("heads-changed", () => throttledSave())
    throttledSave()

    // Subscribe to ephemeral messages for this sedimentree
    void (async () => {
      try {
        const subduction = await this.#subduction
        const sid = toSedimentreeId(query.documentId)
        await subduction.subscribeEphemeral([Topic.fromBytes(sid.toBytes())])
      } catch (e) {
        this.#log("ephemeral subscribe failed: %O", e)
      }
    })()

    this.#recompute()
  }

  detach(documentId: DocumentId): void {
    const sid = toSedimentreeId(documentId)
    const sidStr = sid.toString()
    this.#entries.delete(sidStr)
    this.#scheduler.resetHealState(sidStr)
  }

  /** Reset entries stuck in "all-failed" so they sync again. */
  retryFailedSyncs(): void {
    for (const entry of this.#entries.values()) {
      if (entry.lastSyncResult === "all-failed" && !entry.syncInFlight) {
        entry.lastSyncResult = null
        this.#scheduler.resetHealState(entry.sedimentreeId.toString())
      }
    }
    this.#recompute()
  }

  // ── Central recompute ───────────────────────────────────────────────

  #recompute() {
    for (const entry of this.#entries.values()) {
      this.#recomputeEntry(entry)
    }
  }

  #recomputeEntry(entry: SedimentreeEntry) {
    // Fragment processing runs independently of sync state
    if (entry.pendingFragmentRequests.size > 0 && !entry.processingFragments) {
      entry.processingFragments = true
      void this.#processFragmentRequests(entry)
    }

    switch (entry.syncState) {
      case "initializing": {
        // After a successful sync, batch-load blobs into the handle
        if (entry.lastSyncResult === "succeeded" && !entry.blobLoadInFlight) {
          entry.blobLoadInFlight = true
          void this.#loadBlobsAndTransition(entry)
          return
        }

        if (!entry.syncInFlight && !entry.blobLoadInFlight) {
          const noPeersButConnectionChanged =
            entry.lastSyncResult === "no-peers" &&
            entry.lastSyncGeneration !== this.#connectionGeneration()

          if (entry.lastSyncResult === null || noPeersButConnectionChanged) {
            // Sync when we haven't tried yet (null) or when the last
            // attempt found no peers and a connection state has changed
            // since then (new peer connected, adapter state transitioned).
            // Re-enter pending in case the query was previously unavailable.
            entry.query.sourcePending("subduction")
            entry.syncInFlight = true
            void this.#doSync(entry)
          } else if (
            entry.handle.heads().length === 0 &&
            !this.#anyConnectionManagerConnecting()
          ) {
            // All connections settled and sync failed — give up.
            this.#log("marking as unavailable")
            entry.query.sourceUnavailable("subduction")
          }
        }
        return
      }

      case "running": {
        const noPeersButConnectionChanged =
          entry.lastSyncResult === "no-peers" &&
          entry.lastSyncGeneration !== this.#connectionGeneration()

        if (
          !entry.syncInFlight &&
          (entry.lastSyncResult === null || noPeersButConnectionChanged)
        ) {
          entry.syncInFlight = true
          void this.#doSync(entry)
        }
        return
      }
    }
  }

  // ── Async work kicked off by #recompute ─────────────────────────────

  async #doSync(entry: SedimentreeEntry) {
    const { sedimentreeId } = entry
    const sid = sedimentreeId.toString().slice(0, 8)
    entry.lastSyncGeneration = this.#connectionGeneration()

    try {
      const subduction = await this.#subduction

      // Flush any pending throttled save and wait for in-progress saves
      // to complete. This ensures that all locally-known commits have
      // been persisted to subduction before the sync round reads state.
      // Without this, a sync can race ahead of the save and send stale
      // data, causing a "one-behind" pattern on the remote peer.
      entry.flushSave.flush()
      await entry.saveSettled

      this.#log(`doSync ${sid} (state=${entry.syncState})`)
      const peerResultMap = await subduction.syncWithAllPeers(
        sedimentreeId,
        true
      )

      const results = peerResultMap.entries()
      const anySuccess = results.some(r => r.success)
      this.#log(
        `doSync ${sid}: ${results.length} peer(s), success=${anySuccess}`
      )

      // Check if any data was received from peers
      const dataReceived = results.some(r => {
        const s = r.stats
        return s && (s.commitsReceived > 0 || s.fragmentsReceived > 0)
      })

      // If new data was received, immediately load it into the handle.
      // This makes sync reactive — the handle updates as soon as data
      // arrives, without waiting for periodic timers or state transitions.
      if (dataReceived) {
        await this.#loadBlobsIntoHandle(entry, subduction)
      }

      if (results.length === 0) {
        entry.lastSyncResult = "no-peers"
      } else if (results.every(r => !r.success)) {
        entry.lastSyncResult = "all-failed"
        this.#scheduler.scheduleHealSync(entry.sedimentreeId)
      } else {
        entry.lastSyncResult = "succeeded"
        this.#scheduler.resetHealState(sedimentreeId.toString())
      }
    } catch (e) {
      console.error(`[subduction] doSync THREW for ${sid}:`, e)
      entry.lastSyncResult = "all-failed"
      this.#scheduler.scheduleHealSync(sedimentreeId)
    } finally {
      entry.syncInFlight = false
      // If new commits were saved or a new connection was established
      // while this sync was in flight, re-sync immediately.
      if (entry.needsResync || entry.lastSyncResult === null) {
        this.#log(
          `doSync ${sid} finally: re-sync needed ` +
            `(needsResync=${entry.needsResync}, lastSyncResult=${entry.lastSyncResult})`
        )
        entry.needsResync = false
        entry.lastSyncResult = null
      } else {
        this.#log(
          `doSync ${sid} finally: no re-sync ` +
            `(needsResync=${entry.needsResync}, lastSyncResult=${entry.lastSyncResult})`
        )
      }
      this.#recompute()
    }
  }

  /**
   * Load all blobs for a sedimentree from Subduction and apply them to the
   * handle via `Automerge.loadIncremental`. If new data was loaded, signal
   * the query so it can transition to "ready".
   *
   * This is called reactively after any `syncWithAllPeers` that received
   * data, making handle updates immediate rather than timer-driven.
   */
  async #loadBlobsIntoHandle(
    entry: SedimentreeEntry,
    subduction: Subduction
  ): Promise<boolean> {
    const sid = entry.sedimentreeId.toString().slice(0, 8)
    const allBlobs = await subduction.getBlobs(entry.sedimentreeId)
    const totalBytes = allBlobs
      ? allBlobs.reduce((n, b) => n + b.byteLength, 0)
      : 0
    this.#log(
      `loadBlobsIntoHandle ${sid}: ${
        allBlobs?.length ?? 0
      } blob(s), ${totalBytes} bytes, heads=${entry.handle.heads().length}`
    )
    if (!allBlobs || allBlobs.length === 0) return false

    entry.handle.update(d => {
      let result = d
      for (const blob of allBlobs) {
        result = Automerge.loadIncremental(result, blob)
      }
      return result
    })

    return true
  }

  async #loadBlobsAndTransition(entry: SedimentreeEntry) {
    try {
      const subduction = await this.#subduction
      await this.#loadBlobsIntoHandle(entry, subduction)

      entry.syncState = "running"

      if (entry.handle.heads().length === 0) {
        if (!this.#anyConnectionManagerConnecting()) {
          // No data after a successful sync and no pending connections —
          // the document is genuinely unavailable. If data arrives later
          // via #handleDataFound, it calls sourcePending to re-enter
          // "loading" → "ready".
          entry.query.sourceUnavailable("subduction")
        }
        // Otherwise endpoints are still connecting — stay pending,
        // data may arrive once the connection is established.
      } else {
        // Data loaded — notify the query so it can transition to "ready".
        entry.query.sourcePending("subduction")
      }
    } catch (e) {
      this.#log(
        `loadBlobsAndTransition threw for ${entry.sedimentreeId
          .toString()
          .slice(0, 8)}: %O`,
        e
      )
      // Transition to running anyway so live pushes aren't permanently blocked.
      // The periodic sync will retry loading data.
      entry.syncState = "running"
      entry.lastSyncResult = null
    } finally {
      entry.blobLoadInFlight = false
      this.#recompute()
    }
  }

  // ── Saving local changes to subduction ──────────────────────────────

  async #save<T>(entry: SedimentreeEntry, doc: Automerge.Doc<T>) {
    const currentHeads = Automerge.getHeads(doc)
    const currentSet = new Set(currentHeads)

    if (
      currentSet.size === entry.lastSavedHeads.size &&
      [...currentSet].every(h => entry.lastSavedHeads.has(h))
    ) {
      return
    }

    // Replace the save-settled promise so that #doSync can await this
    // save completing before starting a network sync round.
    let resolveSaveSettled!: () => void
    entry.saveSettled = new Promise<void>(r => {
      resolveSaveSettled = r
    })

    try {
      const previousHeads = entry.lastSavedHeads
      entry.lastSavedHeads = currentSet

      const subduction = await this.#subduction
      const sid = entry.sedimentreeId.toString().slice(0, 8)
      const changeCount = Automerge.getChangesMetaSince(
        doc,
        Array.from(previousHeads)
      ).length
      this.#log(
        `#save ${sid}: ${changeCount} change(s), ` +
          `state=${entry.syncState}, syncInFlight=${entry.syncInFlight}`
      )
      await this.#saveNewCommits(entry, doc, subduction, previousHeads)
    } finally {
      resolveSaveSettled()
    }

    // Trigger immediate sync to peers. If a sync is already in flight,
    // flag for re-sync when it completes (otherwise the in-flight sync
    // would overwrite lastSyncResult and the new commits would be lost).
    if (entry.syncInFlight) {
      this.#log(
        `#save ${entry.sedimentreeId
          .toString()
          .slice(0, 8)}: setting needsResync=true (sync in flight)`
      )
      entry.needsResync = true
    } else if (entry.lastSyncResult !== "no-peers") {
      entry.lastSyncResult = null
    }
    this.#recompute()
  }

  async #saveNewCommits<T>(
    entry: SedimentreeEntry,
    doc: Automerge.Doc<T>,
    subduction: Subduction,
    sinceHeads: Set<string>
  ): Promise<void> {
    const changes = Automerge.getChangesMetaSince(doc, Array.from(sinceHeads))

    await Promise.all(
      changes.map(async meta => {
        try {
          if (!entry.recentlySavedHashes.add(meta.hash)) return

          const commitBytes = automergeMeta(doc).getChangeByHash(meta.hash)
          const head = CommitId.fromHexString(meta.hash)
          const parents = meta.deps.map(dep => CommitId.fromHexString(dep))

          const result = await subduction.addCommit(
            entry.sedimentreeId,
            head,
            parents,
            commitBytes
          )

          if (result !== undefined) {
            const key = `${result.head.toString()}:${result.depth.value}`
            entry.pendingFragmentRequests.set(key, result)
          }
        } catch (e) {
          console.warn(
            `[SubductionSource] save commit failed for ${meta.hash}:`,
            e
          )
        }
      })
    )
  }

  // ── Heal / scheduler delegation ─────────────────────────────────────

  /** Check whether a sedimentree is currently in heal-backoff. */
  isHealing(sedimentreeId: SedimentreeId): boolean {
    return this.#scheduler.isHealing(sedimentreeId)
  }

  // ── Shutdown ────────────────────────────────────────────────────────

  async shutdown() {
    // 1. Stop reconnect loops and prevent new transports
    for (const mgr of this.#connectionManagers) {
      mgr.shutdown()
    }

    // 2. Stop scheduled sync timers (no new sync rounds will be triggered)
    this.#scheduler.shutdown()

    // 3. Flush all pending throttled saves so they start executing
    for (const entry of this.#entries.values()) {
      entry.flushSave.flush()
    }

    // 4. Wait for all in-flight #save() calls to complete
    await Promise.all(
      Array.from(this.#entries.values()).map(e => e.saveSettled)
    )

    // 5. Wait for SubductionStorageBridge writes to land on disk
    await this.#storage.awaitSettled()

    // 6. Disconnect all Wasm-side transports gracefully, then free.
    //    If hydration failed, this.#subduction is a rejected promise —
    //    treat that as a no-op (nothing to disconnect or free).
    let subduction: Subduction | null = null
    try {
      subduction = await this.#subduction
    } catch (e) {
      this.#log("subduction never initialized, skipping teardown: %O", e)
      return
    }
    try {
      await subduction.disconnectAll()
    } catch (e) {
      this.#log("error disconnecting subduction transports: %O", e)
    } finally {
      try {
        subduction.free()
      } catch (e) {
        this.#log("error freeing subduction resources: %O", e)
      }
    }
  }

  // ── Ephemeral messaging ──────────────────────────────────────────────

  /** Publish an ephemeral payload to subduction peers for the given document. */
  async publishEphemeral(documentId: DocumentId, payload: Uint8Array) {
    try {
      const subduction = await this.#subduction
      const sid = toSedimentreeId(documentId)
      await subduction.publishEphemeral(Topic.fromBytes(sid.toBytes()), payload)
    } catch (e) {
      this.#log("ephemeral publish failed: %O", e)
    }
  }

  // ── Fragment processing ─────────────────────────────────────────────

  async #processFragmentRequests(entry: SedimentreeEntry): Promise<void> {
    const subduction = await this.#subduction
    const doc = entry.handle.doc()
    if (!doc) {
      entry.processingFragments = false
      return
    }

    const requests = Array.from(entry.pendingFragmentRequests.values())
    entry.pendingFragmentRequests.clear()

    const validHeads = requests
      .map(r => r.head)
      .filter(head => head && (head as any).__wbg_ptr)

    if (validHeads.length > 0) {
      const innerDoc = automergeMeta(doc)
      const sam = new SedimentreeAutomerge(innerDoc)
      const fragmentStates = sam.buildFragmentStore(
        validHeads,
        this.#fragmentStateStore,
        new HashMetric()
      )

      for (const fragmentState of fragmentStates) {
        try {
          const members = fragmentState
            .members()
            .map((commitId: CommitId): string => commitId.toHexString())

          const fragmentBlob = Automerge.saveBundle(doc, members)

          await subduction.addFragment(
            entry.sedimentreeId,
            fragmentState.head_id(),
            fragmentState.boundary().keys(),
            fragmentState.checkpoints(),
            fragmentBlob
          )
        } catch (e) {
          this.#log(
            "fragment processing failed for %s: %O",
            entry.sedimentreeId,
            e
          )
        }
      }
    }

    entry.processingFragments = false
    this.#recompute()
  }
}
