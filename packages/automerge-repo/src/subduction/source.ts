import * as Automerge from "@automerge/automerge/slim"
import {
  SedimentreeId,
  Subduction,
  Digest,
  SedimentreeAutomerge,
  FragmentStateStore,
  HashMetric,
  setSubductionLogLevel,
  type FragmentRequested,
} from "@automerge/automerge-subduction/slim"
import { DocumentSource } from "../DocumentSource.js"
import { DocumentQuery } from "../DocumentQuery.js"
import { DocumentId, PeerId } from "../types.js"
import { automergeMeta, toSedimentreeId, toDocumentId } from "./helpers.js"
import { DocHandle } from "../index.js"
import type { StorageId } from "../storage/types.js"
import type { UrlHeads } from "../types.js"
import { throttle } from "../helpers/throttle.js"
import { HashRing } from "../helpers/HashRing.js"
import debug from "debug"
import { SubductionStorageBridge } from "./storage.js"
import { WebSocketTransport } from "./websocket-transport.js"

const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 30000
const RECENTLY_SAVED_CACHE_SIZE = 256

// ── Self-healing sync constants ─────────────────────────────────────────
const HEAL_INITIAL_DELAY_MS = 2_000
const HEAL_MAX_DELAY_MS = 60_000
const HEAL_MAX_ATTEMPTS = 10

// ── Connection state ────────────────────────────────────────────────────
type ConnectionState = "connecting" | "running" | "awaiting-reconnect"

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
  blobLoadInFlight: boolean

  // Save tracking
  lastSavedHeads: Set<string>
  recentlySavedHashes: HashRing

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

/** Callback when heal sync gives up after all retry attempts. */
export type OnHealExhausted = (documentId: DocumentId) => void

export interface SubductionSourceOptions {
  peerId: PeerId
  storage: SubductionStorageBridge
  signer: any
  websocketEndpoints: string[]
  onRemoteHeadsChanged?: OnRemoteHeadsChanged
  onEphemeral?: OnEphemeral
  onHealExhausted?: OnHealExhausted

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
  #connectionStates = new Map<string, ConnectionState>()

  // ── Self-healing sync state ─────────────────────────────────────────
  #healTimers = new Map<string, ReturnType<typeof setTimeout>>()
  #healBackoff = new Map<string, number>()
  #healAttempts = new Map<string, number>()
  #onHealExhausted?: OnHealExhausted

  // ── Periodic sync state ───────────────────────────────────────────
  #periodicSyncTimer: ReturnType<typeof setInterval> | null = null
  #batchSyncTimer: ReturnType<typeof setInterval> | null = null
  #periodicSyncInProgress = false
  #batchSyncInProgress = false

  constructor({
    peerId,
    storage,
    signer,
    websocketEndpoints,
    onRemoteHeadsChanged,
    onEphemeral,
    onHealExhausted,
    periodicSyncInterval = 30_000,
    batchSyncInterval = 300_000,
  }: SubductionSourceOptions) {
    // Default to "warn" so the Rust side is quiet. When the debug npm module
    // has subduction namespaces enabled (via localStorage.debug), open the
    // Rust tracing filter so the messages actually reach the JS logger.
    const subductionDebugRequested =
      typeof localStorage !== "undefined" &&
      /subduction/i.test(localStorage.getItem("debug") ?? "")
    try {
      setSubductionLogLevel(subductionDebugRequested ? "debug" : "warn")
    } catch {
      // Wasm module not yet initialized
    }
    this.#log = debug(`automerge-repo:subduction(${peerId})`)
    this.#storage = storage
    this.#onHealExhausted = onHealExhausted

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

    this.#subduction = Subduction.hydrate(
      signer,
      storage,
      undefined, // service_name
      undefined, // hash_metric_override
      undefined, // max_pending_blob_requests
      undefined, // policy
      onRemoteHeads,
      onEphemeral
    )

    for (const url of websocketEndpoints) {
      this.#connectionStates.set(url, "connecting")
      this.#manageConnection(url)
    }

    this.#storage.on("commit-saved", this.#handleDataFound.bind(this))
    this.#storage.on("fragment-saved", this.#handleDataFound.bind(this))

    // ── Periodic sync timers ──────────────────────────────────────────
    if (periodicSyncInterval > 0) {
      this.#periodicSyncTimer = setInterval(() => {
        void this.#runPeriodicSync()
      }, periodicSyncInterval)
    }
    if (batchSyncInterval > 0) {
      this.#batchSyncTimer = setInterval(() => {
        void this.#runBatchSync()
      }, batchSyncInterval)
    }
  }

  // ── Connection management ───────────────────────────────────────────

  async #manageConnection(url: string) {
    const serviceName = new URL(url).host
    let backoff = RECONNECT_BASE_MS

    while (true) {
      this.#setConnectionState(url, "connecting")

      try {
        const transport = await WebSocketTransport.connect(url)
        const subduction = await this.#subduction
        await subduction.connectTransport(transport, serviceName)
        this.#setConnectionState(url, "running")
        backoff = RECONNECT_BASE_MS

        await transport.closed()
        this.#log("disconnected from %s", url)
      } catch (e) {
        this.#log("connection to %s failed: %O", url, e)
      }

      this.#setConnectionState(url, "awaiting-reconnect")
      await new Promise(r => setTimeout(r, backoff))
      backoff = Math.min(backoff * 2, RECONNECT_MAX_MS)
    }
  }

  #setConnectionState(url: string, state: ConnectionState) {
    const prev = this.#connectionStates.get(url)
    if (prev === state) return
    this.#connectionStates.set(url, state)

    if (state === "running") {
      this.#log("connected to %s", url)
      for (const entry of this.#entries.values()) {
        entry.lastSyncResult = null
        entry.query.sourcePending("subduction")
      }
    }

    this.#recompute()
  }

  #hasConnectingEndpoints(): boolean {
    for (const state of this.#connectionStates.values()) {
      if (state === "connecting") return true
    }
    return false
  }

  // ── Storage events ──────────────────────────────────────────────────

  #handleDataFound(id: SedimentreeId, _digest: Digest, blob: Uint8Array) {
    const entry = this.#entries.get(id.toString())
    if (!entry) return
    if (entry.syncState !== "running") return

    this.#log(`handleDataFound ${id}`)
    entry.handle.update(d => Automerge.loadIncremental(d, blob))
  }

  // ── Attach / detach ─────────────────────────────────────────────────

  attach(query: DocumentQuery<unknown>): void {
    const sid = toSedimentreeId(query.documentId)
    const sidStr = sid.toString()
    if (this.#entries.has(sidStr)) return

    this.#entries.set(sidStr, {
      syncState: "initializing",
      query,
      handle: query.handle,
      sedimentreeId: sid,
      syncInFlight: false,
      lastSyncResult: null,
      blobLoadInFlight: false,
      lastSavedHeads: new Set(),
      recentlySavedHashes: new HashRing(RECENTLY_SAVED_CACHE_SIZE),
      pendingFragmentRequests: new Map(),
      processingFragments: false,
    })

    query.sourcePending("subduction")

    const throttledSave = throttle(() => {
      const entry = this.#entries.get(sidStr)
      if (!entry) return
      const doc = entry.handle.doc()
      if (!doc) return
      this.#save(entry, doc)
    }, 100)

    query.handle.on("heads-changed", () => throttledSave())
    throttledSave()

    // Subscribe to ephemeral messages for this sedimentree
    void (async () => {
      try {
        const subduction = await this.#subduction
        await subduction.subscribeEphemeral([toSedimentreeId(query.documentId)])
      } catch (e) {
        this.#log("ephemeral subscribe failed: %O", e)
      }
    })()

    this.#recompute()
  }

  detach(documentId: DocumentId): void {}

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

        // Try to sync if we haven't yet or if the result was cleared
        if (!entry.syncInFlight && !entry.blobLoadInFlight) {
          if (entry.lastSyncResult === null) {
            entry.syncInFlight = true
            void this.#doSync(entry)
          } else if (
            entry.handle.heads().length === 0 &&
            !this.#hasConnectingEndpoints()
          ) {
            this.#log("marking as unavailable")
            entry.query.sourceUnavailable("subduction")
          }
        }
        return
      }

      case "running": {
        // Re-sync when lastSyncResult is cleared (new peer connected)
        if (!entry.syncInFlight && entry.lastSyncResult === null) {
          entry.syncInFlight = true
          void this.#doSync(entry)
        }
        return
      }
    }
  }

  // ── Async work kicked off by #recompute ─────────────────────────────

  async #doSync(entry: SedimentreeEntry) {
    const subduction = await this.#subduction
    const { sedimentreeId } = entry

    this.#log(`syncing sedimentree ${sedimentreeId.toString().slice(0, 8)}...`)
    const peerResultMap = await subduction.syncWithAllPeers(sedimentreeId, true)

    for (const result of peerResultMap.entries()) {
      const stats = result.stats
      if (stats && !stats.isEmpty) {
        this.#log(
          `sync stats: received ${stats.commitsReceived} commits, ` +
            `${stats.fragmentsReceived} fragments; ` +
            `sent ${stats.commitsSent} commits, ` +
            `${stats.fragmentsSent} fragments`
        )
      }
    }

    const results = peerResultMap.entries()
    if (results.length === 0) {
      entry.lastSyncResult = "no-peers"
    } else if (results.every(r => !r.success)) {
      entry.lastSyncResult = "all-failed"
      this.#scheduleHealSync(entry.sedimentreeId)
    } else {
      entry.lastSyncResult = "succeeded"
      this.#resetHealState(sedimentreeId.toString())
    }

    entry.syncInFlight = false
    this.#recompute()
  }

  async #loadBlobsAndTransition(entry: SedimentreeEntry) {
    const subduction = await this.#subduction
    const allBlobs = await subduction.getBlobs(entry.sedimentreeId)
    if (allBlobs && allBlobs.length > 0) {
      entry.handle.update(d => {
        let result = d
        for (const blob of allBlobs) {
          result = Automerge.loadIncremental(result, blob)
        }
        return result
      })
    }

    entry.syncState = "running"
    entry.blobLoadInFlight = false

    // If after loading there's still no data, mark unavailable.
    // Data may arrive later via subscription (handleDataFound),
    // which will update the handle and transition the query to ready.
    if (entry.handle.heads().length === 0) {
      entry.query.sourceUnavailable("subduction")
    }
    this.#recompute()
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

    const previousHeads = entry.lastSavedHeads
    entry.lastSavedHeads = currentSet

    const subduction = await this.#subduction
    await this.#saveNewCommits(entry, doc, subduction, previousHeads)

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
          const parents = meta.deps.map(dep => Digest.fromHexString(dep))

          const result = await subduction.addCommit(
            entry.sedimentreeId,
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

  // ── Self-healing sync ────────────────────────────────────────────────
  //
  // When syncWithAllPeers fails for a sedimentree, we schedule a retry
  // with exponential backoff (2s → 60s cap). After HEAL_MAX_ATTEMPTS
  // consecutive failures we give up and notify the application via the
  // onHealExhausted callback.

  #scheduleHealSync(sedimentreeId: SedimentreeId) {
    const key = sedimentreeId.toString()
    const attempts = this.#healAttempts.get(key) ?? 0

    if (attempts >= HEAL_MAX_ATTEMPTS) {
      this.#log(
        `heal sync exhausted after ${attempts} attempts for ${key.slice(0, 8)}`
      )
      this.#onHealExhausted?.(toDocumentId(sedimentreeId))
      return
    }

    // Debounce: restart the window if a timer is already pending.
    const existing = this.#healTimers.get(key)
    if (existing !== undefined) clearTimeout(existing)

    const delay = this.#healBackoff.get(key) ?? HEAL_INITIAL_DELAY_MS

    this.#log(
      `scheduling heal sync for ${key.slice(0, 8)} in ${delay}ms ` +
        `(attempt ${attempts + 1}/${HEAL_MAX_ATTEMPTS})`
    )

    const timer = setTimeout(() => {
      void this.#executeHealSync(sedimentreeId)
    }, delay)
    this.#healTimers.set(key, timer)
  }

  async #executeHealSync(sedimentreeId: SedimentreeId) {
    const key = sedimentreeId.toString()
    this.#healTimers.delete(key)
    this.#healAttempts.set(key, (this.#healAttempts.get(key) ?? 0) + 1)

    this.#log(`executing heal sync for ${key.slice(0, 8)}...`)

    try {
      const subduction = await this.#subduction
      const peerResultMap = await subduction.syncWithAllPeers(
        sedimentreeId,
        true
      )

      const results = peerResultMap.entries()
      const anyFailed = results.some(
        r => !r.success || (r.transportErrors?.length ?? 0) > 0
      )

      if (anyFailed || results.length === 0) {
        const currentDelay = this.#healBackoff.get(key) ?? HEAL_INITIAL_DELAY_MS
        const nextDelay = Math.min(currentDelay * 2, HEAL_MAX_DELAY_MS)
        this.#healBackoff.set(key, nextDelay)
        this.#scheduleHealSync(sedimentreeId)
      } else {
        this.#log(`heal sync succeeded for ${key.slice(0, 8)}`)
        this.#resetHealState(key)
      }
    } catch (e) {
      this.#log(`heal sync threw for ${key.slice(0, 8)}: %O`, e)
      const currentDelay = this.#healBackoff.get(key) ?? HEAL_INITIAL_DELAY_MS
      const nextDelay = Math.min(currentDelay * 2, HEAL_MAX_DELAY_MS)
      this.#healBackoff.set(key, nextDelay)
      this.#scheduleHealSync(sedimentreeId)
    }
  }

  #resetHealState(key: string) {
    const timer = this.#healTimers.get(key)
    if (timer !== undefined) clearTimeout(timer)
    this.#healTimers.delete(key)
    this.#healBackoff.delete(key)
    this.#healAttempts.delete(key)
  }

  /** Check whether a sedimentree is currently in heal-backoff. */
  isHealing(sedimentreeId: SedimentreeId): boolean {
    return this.#healTimers.has(sedimentreeId.toString())
  }

  // ── Periodic background sync ────────────────────────────────────────
  //
  // Two timers run in the background:
  //
  //   periodicSync  (default 10s)  — per-document sync for each open handle,
  //       skipping entries already in heal-backoff.
  //
  //   batchSync     (default 5 min) — syncs every open handle. On full
  //       success, resets all heal state.

  async #runPeriodicSync() {
    if (this.#periodicSyncInProgress) return
    this.#periodicSyncInProgress = true
    this.#log("starting periodic per-document sync")

    try {
      const subduction = await this.#subduction

      for (const [key, entry] of this.#entries.entries()) {
        // Skip sedimentrees already in heal-backoff
        if (this.#healTimers.has(key)) continue

        try {
          const peerResultMap = await subduction.syncWithAllPeers(
            entry.sedimentreeId,
            true
          )

          const results = peerResultMap.entries()
          if (results.length === 0) continue

          const anyFailed = results.some(
            r => !r.success || (r.transportErrors?.length ?? 0) > 0
          )

          if (anyFailed) {
            this.#scheduleHealSync(entry.sedimentreeId)
          } else {
            this.#resetHealState(key)
          }
        } catch (e) {
          this.#log(`periodic sync failed for ${key.slice(0, 8)}: %O`, e)
        }
      }
    } finally {
      this.#periodicSyncInProgress = false
    }
  }

  async #runBatchSync() {
    if (this.#batchSyncInProgress) return
    this.#batchSyncInProgress = true
    this.#log("starting batch sync (all open handles)")

    try {
      const subduction = await this.#subduction
      let allSucceeded = true

      for (const [key, entry] of this.#entries.entries()) {
        try {
          const peerResultMap = await subduction.syncWithAllPeers(
            entry.sedimentreeId,
            true
          )

          const results = peerResultMap.entries()
          if (results.length === 0) continue

          const anyFailed = results.some(
            r => !r.success || (r.transportErrors?.length ?? 0) > 0
          )
          if (anyFailed) allSucceeded = false
        } catch (e) {
          allSucceeded = false
          this.#log(`batch sync failed for ${key.slice(0, 8)}: %O`, e)
        }
      }

      if (allSucceeded) {
        this.#log("batch sync succeeded — resetting all heal state")
        for (const timer of this.#healTimers.values()) {
          clearTimeout(timer)
        }
        this.#healTimers.clear()
        this.#healBackoff.clear()
        this.#healAttempts.clear()
      } else {
        this.#log("batch sync completed with errors")
      }
    } finally {
      this.#batchSyncInProgress = false
    }
  }

  // ── Shutdown ────────────────────────────────────────────────────────

  shutdown() {
    if (this.#periodicSyncTimer !== null) {
      clearInterval(this.#periodicSyncTimer)
      this.#periodicSyncTimer = null
    }
    if (this.#batchSyncTimer !== null) {
      clearInterval(this.#batchSyncTimer)
      this.#batchSyncTimer = null
    }
    for (const timer of this.#healTimers.values()) {
      clearTimeout(timer)
    }
    this.#healTimers.clear()
    this.#healBackoff.clear()
    this.#healAttempts.clear()
  }

  // ── Ephemeral messaging ──────────────────────────────────────────────

  /** Publish an ephemeral payload to subduction peers for the given document. */
  async publishEphemeral(documentId: DocumentId, payload: Uint8Array) {
    try {
      const subduction = await this.#subduction
      await subduction.publishEphemeral(toSedimentreeId(documentId), payload)
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
            .map((digest: Digest): string => digest.toHexString())

          const fragmentBlob = Automerge.saveBundle(doc, members)

          await subduction.addFragment(
            entry.sedimentreeId,
            fragmentState.head_digest(),
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
