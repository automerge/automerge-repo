import * as Automerge from "@automerge/automerge/slim"
import {
  BlobMeta,
  CommitId,
  CommitInput,
  FragmentRequested,
  FragmentStateStore,
  HashMetric,
  LooseCommit,
  SedimentreeAutomerge,
  SedimentreeId,
  Subduction,
  Topic,
  setSubductionLogLevel,
  type Policy,
  type Transport,
} from "@automerge/automerge-subduction/slim"
import { DocumentSource } from "../DocumentSource.js"
import { DocumentQuery } from "../DocumentQuery.js"
import { DocumentId, PeerId } from "../types.js"
import { automergeMeta, toSedimentreeId, toDocumentId } from "./helpers.js"
import { DocHandle, NetworkAdapterInterface } from "../index.js"
import { ConnectionManager } from "./ConnectionManager.js"
import type { StorageId } from "../storage/types.js"
import type { UrlHeads } from "../types.js"
import { mergeArrays } from "../helpers/mergeArrays.js"
import { throttle, type ThrottledFunction } from "../helpers/throttle.js"
import { HashRing } from "../helpers/HashRing.js"
import debug from "debug"
import { SubductionStorageBridge } from "./storage.js"
import { SubductionConnections } from "./SubductionConnections.js"
import { SyncScheduler, toTimeoutBigInt } from "./SyncScheduler.js"
import { AdapterConnections } from "./AdapterConnections.js"
import { InjectedTransportConnections } from "./InjectedTransportConnections.js"

export type { OnHealExhausted } from "./SyncScheduler.js"

/**
 * Default timeout for `subduction.syncWithAllPeers(...)`. Bounds how
 * long we wait for a single sync round before giving up.
 *
 * Override per-Repo via `RepoConfig.subductionTimeouts.syncMs`.
 */
const DEFAULT_SYNC_TIMEOUT_MS = 60_000

/**
 * Capacity of the per-entry `recentlySavedHashes` ring used to
 * short-circuit `#handleDataFound` for our own self-saved commits.
 *
 * If the ring evicts a hash before its matching `commit-saved` event
 * arrives, `#handleDataFound` falls through to `loadIncremental` on
 * the already-applied commit — O(doc-size) wasted work per evicted
 * entry, turning the flush into O(N²).
 *
 * 16384 covers realistic synchronous bursts with comfortable
 * headroom. At ~64 bytes per hash string, that's ~1 MB per entry.
 */
const RECENTLY_SAVED_CACHE_SIZE = 16384

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
  /**
   * Error from the most recent failed `#save`, or `null` if the
   * most recent save succeeded (or none have run). `flush()`
   * surfaces this so persistent storage failures aren't silently
   * swallowed.
   */
  lastSaveError: unknown
  /**
   * True while `#save` is in its critical section. Concurrent
   * invocations early-return; the throttle's next firing picks up
   * any state that landed during the in-flight save.
   *
   * Must be a strict bool, not a timestamp-with-expiry: an
   * auto-releasing gate would let two `#save` bodies run
   * concurrently and reprocess overlapping change sets. The
   * `try/finally` in `#save` already releases this on every throw;
   * for genuinely-stuck awaits, add a timeout to the specific call
   * instead.
   */
  saveInProgress: boolean
  /**
   * Set by `#save` when its post-await heads observation differs
   * from the heads it sampled before the `addBatch` await. Cleared
   * at the start of each `#save`. `flush()` uses this to decide
   * whether another save round is needed before resolving.
   */
  saveDeltaPending: boolean

  // Fragment processing — decoupled from saves, deduped by head+depth
  pendingFragmentRequests: Map<string, FragmentRequested>
  processingFragments: boolean
  /**
   * Resolves when the current `#processFragmentRequests` run
   * finishes; `null` when no run is in flight. `flush()` awaits this
   * to ensure fragment work is drained before returning.
   */
  fragmentProcessingPromise: Promise<void> | null
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

/**
 * Tunable timeouts for Subduction's sync and heal-retry behaviour.
 *
 * All fields are optional. Sensible defaults apply where omitted.
 */
export interface SubductionTimeouts {
  /**
   * Timeout passed to `subduction.syncWithAllPeers(...)` (the third
   * argument, `timeout_milliseconds`). Bounds how long we wait for a
   * single sync round to a peer set before giving up. Used both for
   * the regular sync path in `SubductionSource` and for the
   * heal-retry path in `SyncScheduler`.
   *
   * Default: 60_000 (60 s).
   */
  syncMs?: number

  /**
   * Initial delay before the first heal retry after a failed sync.
   * Doubles per retry up to `healMaxDelayMs`.
   *
   * Default: 2_000 (2 s).
   */
  healInitialDelayMs?: number

  /**
   * Cap for the heal-retry exponential backoff.
   *
   * Default: 60_000 (60 s).
   */
  healMaxDelayMs?: number

  /**
   * Maximum number of heal-retry attempts before giving up and
   * notifying via `onHealExhausted`.
   *
   * Default: 10.
   */
  healMaxAttempts?: number
}

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
  /**
   * Pre-built subduction transports owned by the caller. Each is registered
   * via `subduction.connectTransport(transport, serviceName)` exactly once.
   * No reconnect is attempted on close. Use this to share a single physical
   * connection (e.g., a multiplexed WebSocket) between subduction and another
   * protocol layer.
   */
  injectedTransports?: {
    transport: Transport
    serviceName: string
    onConnected?: () => void
  }[]
  onRemoteHeadsChanged?: OnRemoteHeadsChanged
  onEphemeral?: OnEphemeral
  onHealExhausted?: (documentId: DocumentId) => void

  policy?: Policy

  /** Tunable timeouts for sync and heal-retry. See {@link SubductionTimeouts}. */
  timeouts?: SubductionTimeouts
}

export class SubductionSource implements DocumentSource {
  #subduction: Promise<Subduction>
  #storage: SubductionStorageBridge
  #entries = new Map<string, SedimentreeEntry>()
  #fragmentStateStore: FragmentStateStore = new FragmentStateStore()
  #log: debug.Debugger
  #connectionManagers: ConnectionManager[] = []
  #scheduler: SyncScheduler
  #syncTimeoutMs: number
  #syncTimeout: bigint | null

  constructor({
    peerId,
    storage,
    signer,
    websocketEndpoints,
    adapters,
    injectedTransports,
    onRemoteHeadsChanged,
    onEphemeral,
    onHealExhausted,
    policy,
    timeouts,
  }: SubductionSourceOptions) {
    this.#syncTimeoutMs = timeouts?.syncMs ?? DEFAULT_SYNC_TIMEOUT_MS
    // Validate + coerce once at construction so the wasm boundary
    // never sees a non-integer / NaN / negative bigint conversion.
    this.#syncTimeout = toTimeoutBigInt(
      this.#syncTimeoutMs,
      "subductionTimeouts.syncMs"
    )
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

    const hasInjected =
      injectedTransports !== undefined && injectedTransports.length > 0
    if (websocketEndpoints.length > 0 || adapters.length > 0 || hasInjected) {
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

    if (hasInjected) {
      const injected = new InjectedTransportConnections(this.#subduction)
      for (const { transport, serviceName, onConnected } of injectedTransports!) {
        injected.addTransport(transport, serviceName, onConnected)
      }
      this.#connectionManagers.push(injected)
    }

    for (const mgr of this.#connectionManagers) {
      mgr.onChange(() => this.#recompute())
    }

    this.#storage.on("commit-saved", this.#handleDataFound.bind(this))
    this.#storage.on("fragment-saved", this.#handleDataFound.bind(this))

    // ── Sync scheduler ────────────────────────────────────────────────
    this.#scheduler = new SyncScheduler({
      subduction: this.#subduction,
      log: this.#log,
      onSyncDataReceived: async (sedimentreeId, subduction) => {
        const entry = this.#entries.get(sedimentreeId.toString())
        if (entry) {
          await this.#loadBlobsIntoHandle(entry, subduction)
        }
      },
      onHealExhausted,
      syncTimeoutMs: this.#syncTimeoutMs,
      healInitialDelayMs: timeouts?.healInitialDelayMs,
      healMaxDelayMs: timeouts?.healMaxDelayMs,
      healMaxAttempts: timeouts?.healMaxAttempts,
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

  #handleDataFound(id: SedimentreeId, commitId: CommitId, blob: Uint8Array) {
    const entry = this.#entries.get(id.toString())
    if (!entry) return

    // During "initializing", let #loadBlobsAndTransition handle the
    // complete blob load atomically. Applying individual commits here
    // would cause premature "ready" transitions (the handle gets heads > 0
    // from a partial load, triggering DocumentQuery to resolve whenReady()
    // before the full document is available).
    if (entry.syncState === "initializing") return

    // If we just persisted this commit ourselves (it originated from a
    // local `handle.change()`), the handle already contains it.
    // `loadIncremental` of an already-applied commit is O(doc size)
    // wasted work — running it once per local commit during a flush
    // turns the save loop into O(N²) for N local writes. Skip the
    // re-application; `recentlySavedHashes` is populated synchronously
    // before `#saveNewCommits` calls `await subduction.addBatch(...)`,
    // so the hash is present before the bridge fires `commit-saved`.
    if (entry.recentlySavedHashes.has(commitId.toHexString())) return

    this.#log(`handleDataFound ${id}`)
    entry.handle.update(d => Automerge.loadIncremental(d, blob))

    // If the query was previously marked unavailable (e.g. sync completed
    // before data arrived), re-trigger a recompute so the query detects the
    // newly-loaded heads and transitions to "ready".
    entry.query.sourcePending("subduction")
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

    // Save throttle. Concurrency is enforced inside `#save` itself
    // (the `saveInProgress` gate makes concurrent invocations
    // early-return), so the throttle just needs to coalesce rapid
    // `heads-changed` events into a single save attempt per 100ms
    // window.
    const throttledSave = throttle(() => {
      const entry = this.#entries.get(sidStr)
      if (!entry) return
      void this.#save(entry)
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
      saveInProgress: false,
      saveDeltaPending: false,
      lastSaveError: null,
      pendingFragmentRequests: new Map(),
      processingFragments: false,
      fragmentProcessingPromise: null,
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

  detach(documentId: DocumentId): void {}

  shareConfigChanged(): void {
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
      entry.fragmentProcessingPromise = this.#processFragmentRequests(entry)
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
        true,
        this.#syncTimeout
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
      // arrives, without waiting for further state transitions.
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
   * data, making handle updates immediate.
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
    allBlobs.sort((a, b) => b.byteLength - a.byteLength)
    entry.handle.update(d =>
      Automerge.loadIncremental(d, mergeArrays(allBlobs))
    )

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
      // A subsequent heal retry or connection-state change will retry loading
      // data.
      entry.syncState = "running"
      entry.lastSyncResult = null
    } finally {
      entry.blobLoadInFlight = false
      this.#recompute()
    }
  }

  // ── Saving local changes to subduction ──────────────────────────────

  /**
   * Persist any new local commits for `entry` into Subduction.
   *
   * Single-flight per entry: concurrent invocations early-return on
   * the `saveInProgress` gate (no promise-chain queue). Each pass
   * processes whatever has accumulated since `entry.lastSavedHeads`
   * and runs at most one `addBatch` round-trip; if the post-await
   * heads check detects a delta, it re-arms the throttle for a
   * follow-up save rather than looping inline.
   *
   * `entry.saveSettled` resolves when any in-flight pass completes.
   *
   * Callers that need per-trigger durability (i.e. "my exact change
   * set is durable") MUST call `entry.flushSave.flush()` themselves
   * before awaiting `entry.saveSettled`, otherwise the gate may have
   * absorbed their trigger into an earlier in-flight pass that
   * predates their change. `#doSync`, `flush()`, and `shutdown()`
   * follow this pattern.
   */
  async #save(entry: SedimentreeEntry) {
    if (entry.saveInProgress) return
    entry.saveInProgress = true
    // Cleared on every entry; the post-save delta check below
    // re-sets it if a follow-up save is needed.
    entry.saveDeltaPending = false

    let resolveSaveSettled!: () => void
    entry.saveSettled = new Promise<void>(r => {
      resolveSaveSettled = r
    })

    try {
      const doc = entry.handle.doc()
      if (!doc) return

      const currentHeads = Automerge.getHeads(doc)
      const currentSet = new Set(currentHeads)

      // Fast-path: heads unchanged since the predecessor's save.
      if (
        currentSet.size === entry.lastSavedHeads.size &&
        [...currentSet].every(h => entry.lastSavedHeads.has(h))
      ) {
        return
      }

      // `entry.lastSavedHeads` advances only after `#saveNewCommits`
      // succeeds (see below). On rejection the next save must see
      // the pre-failure baseline so it can retry.
      const previousHeads = entry.lastSavedHeads

      const subduction = await this.#subduction
      const sid = entry.sedimentreeId.toString().slice(0, 8)
      // `getChangesMetaSince` is O(N) — skip it when nobody is
      // listening for the log message.
      if (this.#log.enabled) {
        const changeCount = Automerge.getChangesMetaSince(
          doc,
          Array.from(previousHeads)
        ).length
        this.#log(
          `#save ${sid}: ${changeCount} change(s), ` +
            `state=${entry.syncState}, syncInFlight=${entry.syncInFlight}`
        )
      }

      let result: { prepFailures: number }
      try {
        result = await this.#saveNewCommits(
          entry,
          doc,
          subduction,
          previousHeads
        )
      } catch (e) {
        // `#saveNewCommits` already logged the cause. Record the
        // error so `flush()` can surface it; leave `lastSavedHeads`
        // unchanged so the next save retries the same baseline.
        entry.lastSaveError = e
        this.#log(`#save ${sid}: persistence failed; will retry`)
        return
      }

      // If any commits failed to prep, leave `lastSavedHeads` at the
      // previous baseline so the next save's `getChangesMetaSince`
      // walk includes the failed commits and retries them.
      // `lastSaveError` was already populated inside
      // `#saveNewCommits`.
      if (result.prepFailures > 0) {
        this.#log(
          `#save ${sid}: ${result.prepFailures} prep failure(s); ` +
            `baseline unchanged for retry`
        )
        return
      }

      // Persistence succeeded. Copy `currentSet` instead of aliasing
      // so future mutations to either side stay isolated.
      entry.lastSaveError = null
      entry.lastSavedHeads = new Set(currentSet)

      // Detect a post-save delta the `heads-changed` listener didn't
      // fire on. `getChangeByHash` calls inside `#saveNewCommits` can
      // shift what `getHeads` returns for the same doc reference on
      // subsequent reads, so the heads we sampled before the await
      // may be stale by the time it resolves. If the current heads
      // differ, re-arm the throttle and signal `flush()` to wait for
      // the next round.
      const currentDoc = entry.handle.doc()
      if (currentDoc) {
        const headsNow = Automerge.getHeads(currentDoc)
        const headsMatch =
          headsNow.length === currentSet.size &&
          headsNow.every(h => currentSet.has(h))

        if (!headsMatch) {
          const newSinceCurrent = Automerge.getChangesMetaSince(
            currentDoc,
            Array.from(currentSet)
          ).length
          if (newSinceCurrent > 0) {
            entry.saveDeltaPending = true
            entry.flushSave()
          }
        }
      }
    } finally {
      entry.saveInProgress = false
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
  ): Promise<{ prepFailures: number }> {
    const changes = Automerge.getChangesMetaSince(doc, Array.from(sinceHeads))
    if (changes.length === 0) return { prepFailures: 0 }

    // Build all CommitInputs synchronously. Skip any change whose
    // hash is already in `recentlySavedHashes` — those represent
    // commits already persisted (or in flight) on a previous round.
    //
    // Per-change failures are collected rather than thrown so we can
    // still persist the successfully-prepped subset. The caller uses
    // the returned `prepFailures` count to decide whether to advance
    // its save baseline (it must not, since the failed commits would
    // otherwise be skipped on the next save).
    const meta = automergeMeta(doc)
    const heads: CommitId[] = []
    const acceptedHashes: string[] = []
    const commitInputs: CommitInput[] = []
    const prepErrors: unknown[] = []

    for (const change of changes) {
      if (entry.recentlySavedHashes.has(change.hash)) continue

      try {
        const commitBytes = meta.getChangeByHash(change.hash)
        const head = CommitId.fromHexString(change.hash)
        const looseCommit = new LooseCommit(
          entry.sedimentreeId,
          head,
          change.deps.map(dep => CommitId.fromHexString(dep)),
          new BlobMeta(commitBytes)
        )
        commitInputs.push(new CommitInput(looseCommit, commitBytes))
        heads.push(head)
        acceptedHashes.push(change.hash)
      } catch (e) {
        console.warn(
          `[SubductionSource] commit input prep failed for ${change.hash}:`,
          e
        )
        prepErrors.push(e)
      }
    }

    // Surface accumulated prep failures via `entry.lastSaveError` so
    // `flush()` can report them. `#save` reads `prepFailures` to
    // decide whether to advance `lastSavedHeads`.
    if (prepErrors.length > 0) {
      entry.lastSaveError =
        prepErrors.length === 1
          ? prepErrors[0]
          : new AggregateError(
              prepErrors,
              `${prepErrors.length} commits failed to prepare`
            )
    }

    if (commitInputs.length === 0) {
      return { prepFailures: prepErrors.length }
    }

    // Record hashes in the ring BEFORE `addBatch` so that the
    // synchronous `commit-saved` events fired from the storage
    // bridge (which run before `addBatch` resolves) find them and
    // skip the `#handleDataFound` `loadIncremental` path.
    for (const hash of acceptedHashes) entry.recentlySavedHashes.add(hash)

    // On failure, roll the ring entries back so the next save can
    // retry. `#save` separately keeps `entry.lastSavedHeads` at its
    // previous value when this rejects.
    try {
      await subduction.addBatch(entry.sedimentreeId, commitInputs, [])
    } catch (e) {
      for (const hash of acceptedHashes) {
        entry.recentlySavedHashes.delete(hash)
      }
      console.warn(
        `[SubductionSource] addBatch failed for ${entry.sedimentreeId
          .toString()
          .slice(0, 8)} (${commitInputs.length} commits):`,
        e
      )
      throw e
    }

    // Derive fragment-boundary requests by checking each
    // freshly-inserted commit's depth and synthesising a
    // `FragmentRequested` for any that lands on a boundary.
    for (const head of heads) {
      try {
        const depth = subduction.commitDepth(head)
        if (depth.isBoundary) {
          const fr = new FragmentRequested(head, depth)
          const key = `${fr.head.toString()}:${fr.depth.value}`
          entry.pendingFragmentRequests.set(key, fr)
        }
      } catch (e) {
        console.warn(
          `[SubductionSource] commitDepth check failed for ${head.toHexString()}:`,
          e
        )
      }
    }

    return { prepFailures: prepErrors.length }
  }

  // ── Heal / scheduler delegation ─────────────────────────────────────

  /** Check whether a sedimentree is currently in heal-backoff. */
  isHealing(sedimentreeId: SedimentreeId): boolean {
    return this.#scheduler.isHealing(sedimentreeId)
  }

  // ── Flush ───────────────────────────────────────────────────────────

  /**
   * Drain pending writes so that all known commits and fragments for
   * the given documents are durable in storage.
   *
   * Each round: force the throttled save to fire, await
   * `saveSettled`, kick off any fragment processing accumulated by
   * that save, await it. Loops until no entry has a re-armed save,
   * pending fragment requests, or fragment processing in flight.
   * Then awaits the storage bridge for the targeted sids.
   *
   * If `documentIds` is `undefined`, every entry is flushed and the
   * bridge wait covers every pending write. Unknown document ids
   * are silently skipped.
   *
   * Rejects with the underlying error from any targeted entry whose
   * last save attempt failed and has not since succeeded; multiple
   * failures are wrapped in an `AggregateError`.
   */
  async flush(documentIds?: DocumentId[]): Promise<void> {
    let targets: SedimentreeEntry[]
    let bridgeSids: string[] | undefined

    if (documentIds === undefined) {
      targets = Array.from(this.#entries.values())
      bridgeSids = undefined // bridge-global wait
    } else {
      const sids = documentIds.map(id => toSedimentreeId(id).toString())
      targets = sids
        .map(sid => this.#entries.get(sid))
        .filter((e): e is SedimentreeEntry => e !== undefined)
      bridgeSids = sids
    }

    // Bounded so pathological mutation/fragmentation patterns can't
    // trap `flush()` forever.
    const MAX_FLUSH_ROUNDS = 8
    for (let round = 0; round < MAX_FLUSH_ROUNDS; round++) {
      // 1. Drain any in-flight commits.
      for (const entry of targets) entry.flushSave.flush()
      await Promise.all(targets.map(e => e.saveSettled))

      // 2. Drain fragment processing kicked off by that save (or
      //    still pending from earlier). `#recomputeEntry` starts
      //    `#processFragmentRequests` if there's work to do and
      //    nothing already in flight; the resulting promise is
      //    captured on the entry.
      for (const entry of targets) this.#recomputeEntry(entry)
      await Promise.all(
        targets.map(e => e.fragmentProcessingPromise ?? Promise.resolve())
      )

      // 3. Stable iff no entry has saves to retry, fragments queued,
      //    or fragment processing still running.
      const anyPending = targets.some(
        e =>
          e.saveDeltaPending ||
          e.pendingFragmentRequests.size > 0 ||
          e.processingFragments
      )
      if (!anyPending) break

      if (round === MAX_FLUSH_ROUNDS - 1) {
        this.#log(
          `flush: hit MAX_FLUSH_ROUNDS=${MAX_FLUSH_ROUNDS}; ` +
            `proceeding with bridge wait anyway`
        )
      }
    }

    // Surface any unrecovered persistence error.
    const errors = targets
      .map(e => e.lastSaveError)
      .filter(e => e !== null && e !== undefined)
    if (errors.length === 1) {
      throw errors[0]
    } else if (errors.length > 1) {
      throw new AggregateError(
        errors,
        `SubductionSource.flush: ${errors.length} entries failed to persist`
      )
    }

    // Wait for the storage bridge writes for the targeted sids to
    // land on disk. When `bridgeSids` is undefined, every pending
    // write is awaited.
    await this.#storage.awaitSettled(bridgeSids)
  }

  // ── Shutdown ────────────────────────────────────────────────────────

  async shutdown() {
    // 1. Stop reconnect loops and prevent new transports
    for (const mgr of this.#connectionManagers) {
      mgr.shutdown()
    }

    // 2. Stop any pending heal-retry timers and prevent new schedules
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

    // 6. Disconnect all Wasm-side transports gracefully.
    //    If hydration failed, this.#subduction is a rejected promise —
    //    treat that as a no-op (nothing to disconnect).
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
    try {
      const subduction = await this.#subduction
      const doc = entry.handle.doc()
      if (!doc) return

      const requests = Array.from(entry.pendingFragmentRequests.values())
      entry.pendingFragmentRequests.clear()

      const validHeads = requests
        .map(r => r.head)
        .filter(head => head && (head as any).__wbg_ptr)

      if (validHeads.length === 0) return

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
    } finally {
      entry.processingFragments = false
      entry.fragmentProcessingPromise = null
      this.#recompute()
    }
  }
}
