import * as Automerge from "@automerge/automerge/slim"
import {
  BlobMeta,
  CommitId,
  CommitInput,
  Fragment,
  FragmentInput,
  LooseCommit,
  SedimentreeId,
  Subduction,
  Topic,
  setSubductionLogLevel,
  type Policy,
} from "@automerge/automerge-subduction/slim"
import { DocumentSource } from "../DocumentSource.js"
import { DocumentQuery, SourcePriority } from "../DocumentQuery.js"
import { DocumentId, PeerId } from "../types.js"
import { toSedimentreeId, toDocumentId } from "./helpers.js"
import { DocHandle, NetworkAdapterInterface } from "../index.js"
import { ConnectionManager } from "./ConnectionManager.js"
import type { StorageId } from "../storage/types.js"
import type { UrlHeads } from "../types.js"
import { mergeArrays } from "../helpers/mergeArrays.js"
import { throttle, type ThrottledFunction } from "../helpers/throttle.js"
import { makeYielder, yieldToMacrotask } from "../helpers/yield.js"
import debug from "debug"
import { SubductionStorageBridge } from "./storage.js"
import { SubductionConnections } from "./SubductionConnections.js"
import { SyncScheduler } from "./SyncScheduler.js"
import { AdapterConnections } from "./AdapterConnections.js"

export type { OnHealExhausted } from "./SyncScheduler.js"

/**
 * Default timeout for `subduction.syncWithAllPeers(...)`. Bounds how
 * long we wait for a single sync round before giving up.
 *
 * Override per-Repo via `RepoConfig.subductionTimeouts.syncMs`.
 */
const DEFAULT_SYNC_TIMEOUT_MS = 60_000

/**
 * Deadline for the final best-effort sync round `shutdown()` runs for
 * entries with saved-but-never-broadcast commits. Deliberately short:
 * the data is already durable on disk (it propagates next session if
 * the push misses), and shutdown must not pin the process on an
 * unresponsive or half-torn-down peer.
 */
const SHUTDOWN_SYNC_TIMEOUT_MS = 5_000

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
  /**
   * Resolves when the in-flight `#doSync` round (if any) completes.
   * Mirrors `saveSettled`; `shutdown()` awaits it so outbound
   * propagation can quiesce before transports are torn down.
   */
  syncSettled: Promise<void>

  // Save tracking
  lastSavedHeads: Set<string>
  /**
   * Hashes that subduction is known to have (either we pushed them, or
   * subduction received them from a peer and fired `commit-saved` /
   * `fragment-saved`). Used in two places:
   *
   * 1. `#prepareInputs` filters `getCommits`/`getFragments` against
   *    this set so we never re-push something subduction already has.
   * 2. `#handleDataFound` short-circuits on a hit, both to avoid
   *    re-applying our own writes (the bridge fires `commit-saved`
   *    synchronously inside `storeBuiltBatch` for each save) and to dedupe
   *    repeated deliveries when both backends carry the same change.
   *
   * Grows unboundedly with doc history (hex hash ≈ 64 B per entry).
   * In practice the doc itself absorbs older commits into fragments,
   * so the set's logical size is `loose commits + fragment heads` —
   * bounded by automerge's compaction policy, not by total history.
   */
  knownHashes: Set<string>
  /**
   * Hashes of commits we currently believe are persisted to local
   * storage as loose-commit records (not as part of a fragment).
   *
   * Updated:
   *  - After `storeBuiltBatch` succeeds in `#saveNewCommits`, for each new
   *    commit we just wrote.
   *  - In the `commit-saved` event handler, for commits the bridge
   *    persisted on our behalf (typically inbound from peers).
   *
   * Drained by `#compactAbsorbed`: after every successful save we
   * diff this set against `Automerge.getCommits(doc)` and `remove`
   * any hash that's no longer reported by automerge (i.e. has been
   * absorbed into a fragment). The disk footprint then shrinks to
   * track the level-0 layer, not the full history of commits we
   * ever wrote.
   */
  persistedCommitHashes: Set<string>
  /**
   * Symmetric counterpart to `persistedCommitHashes` for fragment
   * records. Fragments get absorbed into higher-level fragments the
   * same way commits do; this set lets us garbage-collect those too.
   */
  persistedFragmentHashes: Set<string>
  /**
   * Promise for the in-flight `#compactAbsorbed` pass, or `null` if
   * none is running. Compaction is fire-and-forget from the save
   * loop's perspective — the save returns as soon as `storeBuiltBatch`
   * resolves — but `flush()` awaits this so callers can observe a
   * consistent on-disk footprint after a quiescent point. The gate
   * also prevents two passes piling up on each other if saves are
   * bursting faster than the adapter can service deletes; the next
   * save after a pass completes will pick up any absorption that
   * landed in the interim.
   */
  compactionInFlight: Promise<void> | null
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
   * from the heads it sampled before the `storeBuiltBatch` await. Cleared
   * at the start of each `#save`. `flush()` uses this to decide
   * whether another save round is needed before resolving.
   */
  saveDeltaPending: boolean

  /**
   * Inbound blobs from `commit-saved` / `fragment-saved` events
   * waiting to be applied to the handle. Drained as a single
   * concatenated `loadIncremental` per microtask flush — applying
   * 1000 individual changes via 1000 `handle.update` calls fires the
   * DocHandle listener pipeline 1000 times (heads-changed,
   * DocumentQuery notifications, save throttle re-arms); coalescing
   * collapses that to one notification per burst.
   */
  pendingInbound: Uint8Array[]
  /** Guard against scheduling overlapping microtask flushes. */
  inboundFlushScheduled: boolean
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
   * Default per-call total deadline (milliseconds) for *all* Subduction
   * roundtrip syncs that don't pass their own timeout. This is forwarded
   * to the `Subduction` constructor (`defaultTimeoutMilliseconds`) and so
   * governs every internal roundtrip — not just the explicit
   * `syncWithAllPeers` calls bounded by {@link syncMs}.
   *
   * Default: omitted, which uses Subduction's built-in default (30 s).
   */
  defaultMs?: number

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

/** Intercepts and transforms incoming and outgoing blobs (e.g., for E2EE). */
export interface BlobInterceptor {
  transformOutgoing(
    documentId: DocumentId,
    blob: Uint8Array
  ): Promise<Uint8Array>
  /** Return null to skip the blob. */
  transformIncoming(
    documentId: DocumentId,
    blob: Uint8Array
  ): Promise<Uint8Array | null>
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
  onRemoteHeadsChanged?: OnRemoteHeadsChanged
  onEphemeral?: OnEphemeral
  onHealExhausted?: (documentId: DocumentId) => void

  policy?: Policy

  /**
   * What priority this source should have w.r.t to other sources
   */
  priority?: SourcePriority

  /** Tunable timeouts for sync and heal-retry. See {@link SubductionTimeouts}. */
  timeouts?: SubductionTimeouts

  blobInterceptor?: BlobInterceptor
}

export class SubductionSource implements DocumentSource {
  #subduction: Promise<Subduction>
  #storage: SubductionStorageBridge
  #entries = new Map<string, SedimentreeEntry>()
  #log: debug.Debugger
  #connectionManagers: ConnectionManager[] = []
  #scheduler: SyncScheduler
  #syncTimeoutMs: number
  #syncTimeout: number | null
  #blobInterceptor?: BlobInterceptor
  /**
   * Set at the top of `shutdown()`. Makes `#scheduleRecompute` a
   * no-op so no new background sync rounds spin up mid-teardown; the
   * quiesce pass in `shutdown()` is the only thing that initiates
   * syncs after this point.
   */
  #shuttingDown = false

  readonly priority: SourcePriority

  constructor({
    peerId,
    storage,
    signer,
    websocketEndpoints,
    adapters,
    onRemoteHeadsChanged,
    onEphemeral,
    onHealExhausted,
    priority = 2,
    policy,
    timeouts,
    blobInterceptor,
  }: SubductionSourceOptions) {
    this.#blobInterceptor = blobInterceptor
    this.priority = priority
    this.#syncTimeoutMs = timeouts?.syncMs ?? DEFAULT_SYNC_TIMEOUT_MS
    this.#syncTimeout = this.#syncTimeoutMs
    // Default roundtrip deadline forwarded to the Subduction constructor.
    // The field must be *omitted* (not passed as `undefined`) to get the
    // wasm built-in default (30 s) — passing `undefined` is coerced to a
    // zero deadline and breaks every internal roundtrip.
    const defaultTimeoutOption =
      timeouts?.defaultMs !== undefined
        ? { defaultTimeoutMilliseconds: timeouts.defaultMs }
        : {}
    // Default to "warn" so the Rust side is quiet. When the debug npm module
    // has subduction namespaces enabled (via localStorage.debug), open the
    // Rust tracing filter so the messages actually reach the JS logger.
    // In Service Worker contexts, localStorage is unavailable — check
    // globalThis.__SUBDUCTION_DEBUG as a fallback.
    // Node 25's experimental built-in `localStorage` object satisfies
    // `typeof localStorage !== "undefined"` but throws when its methods
    // are called, so guard for `getItem` being callable too.
    const subductionDebugRequested =
      (typeof localStorage !== "undefined" &&
        typeof localStorage.getItem === "function" &&
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

    // Construct without hydrating: skip preloading persisted sedimentrees
    // from storage at startup. State is loaded lazily on demand instead,
    // which also avoids competing with the service worker's hydration on
    // the same IndexedDB database.
    this.#log("constructing subduction (no hydrate)")
    this.#subduction = Promise.resolve(
      new Subduction({
        signer,
        storage,
        policy,
        onRemoteHeads,
        onEphemeral,
        ...defaultTimeoutOption,
      })
    )

    // ── Connection managers ─────────────────────────────────────────
    const wsConnections = new SubductionConnections(this.#subduction)
    for (const url of websocketEndpoints) {
      void wsConnections.manageConnection(url)
    }
    this.#connectionManagers.push(wsConnections)

    const adapterConnections = new AdapterConnections(this.#subduction, peerId)
    for (const { adapter, serviceName, role } of adapters) {
      adapterConnections.addAdapter(adapter, serviceName, role ?? "connect")
    }
    this.#connectionManagers.push(adapterConnections)

    for (const mgr of this.#connectionManagers) {
      mgr.onChange(() => this.#scheduleRecompute())
    }

    this.#storage.on("commit-saved", (sid, commitId, blob) => {
      const entry = this.#entries.get(sid.toString())
      if (entry) entry.persistedCommitHashes.add(commitId.toHexString())
      this.#handleDataFound(sid, commitId, blob)
    })
    this.#storage.on("fragment-saved", (sid, fragmentHead, blob) => {
      const entry = this.#entries.get(sid.toString())
      if (entry) entry.persistedFragmentHashes.add(fragmentHead.toHexString())
      this.#handleDataFound(sid, fragmentHead, blob)
    })

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

  getSubduction(): Promise<Subduction> {
    return this.#subduction
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
    //
    // The arrival is still a state change for THIS entry: if its sync
    // round already succeeded but `#loadBlobsAndTransition` found no
    // data (the "one-behind" arrival order), nothing else will wake it
    // — recomputes are targeted, so other entries' completions no
    // longer walk this one. Mark it dirty so the walk retries the load.
    if (entry.syncState === "initializing") {
      this.#scheduleRecompute(entry)
      return
    }

    // If the hash is already recorded, this is either:
    //   (a) a self-save echo — `#saveNewCommits` added the hash before
    //       calling `storeBuiltBatch`; subduction then persisted and fired
    //       `commit-saved`. The handle already contains the change, so
    //       re-applying would be O(doc-size) wasted work.
    //   (b) a duplicate delivery (e.g. both sync backends delivered the
    //       same commit). Already buffered or applied.
    const hex = commitId.toHexString()
    if (entry.knownHashes.has(hex)) return

    // Record the hash synchronously so concurrent saves and duplicate
    // deliveries see it immediately, even before the microtask flush
    // applies the blob to the handle.
    entry.knownHashes.add(hex)

    if (this.#blobInterceptor) {
      // E2EE path: each blob has to be async-transformed before it can
      // be handed to Automerge. We can't batch across the async
      // boundary, but the transformed result still funnels through the
      // same `pendingInbound` queue so the eventual loadIncremental
      // benefits from any other blobs that landed in the same
      // microtask window.
      void this.#blobInterceptor
        .transformIncoming(entry.query.documentId, blob)
        .then(result => {
          if (!result) return
          entry.pendingInbound.push(result)
          if (!entry.inboundFlushScheduled) {
            entry.inboundFlushScheduled = true
            queueMicrotask(() => this.#flushInbound(entry))
          }
        })
        .catch(e => {
          this.#log("handleDataFound interceptor error: %O", e)
        })
      return
    }

    entry.pendingInbound.push(blob)

    if (!entry.inboundFlushScheduled) {
      entry.inboundFlushScheduled = true
      queueMicrotask(() => this.#flushInbound(entry))
    }
  }

  /**
   * Apply all queued inbound blobs to the handle in one shot.
   *
   * The bridge fires `commit-saved` / `fragment-saved` once per
   * inbound subduction record, and live sync delivers them one at a
   * time over the wire. Applying each individually triggers the full
   * DocHandle update pipeline (heads-changed listeners, sourcePending
   * notifications, save-throttle re-arms) per change; for a 1000-commit
   * propagation that's 1000 listener storms competing with the inbound
   * wire reads on the event loop. Concatenating per microtask flush
   * collapses each burst into a single handle update.
   *
   * `Automerge.loadIncremental` accepts a concatenation of any
   * `saveIncremental` output, including loose commit bytes and
   * fragment bundle bytes.
   */
  #flushInbound(entry: SedimentreeEntry) {
    entry.inboundFlushScheduled = false
    if (entry.pendingInbound.length === 0) return

    const blobs = entry.pendingInbound
    entry.pendingInbound = []

    const merged = blobs.length === 1 ? blobs[0] : mergeArrays(blobs)
    try {
      entry.handle.update(d => Automerge.loadIncremental(d, merged))
    } catch (e) {
      this.#log(
        `flushInbound ${entry.sedimentreeId.toString().slice(0, 8)}: ` +
          `loadIncremental failed for %d blob(s): %O`,
        blobs.length,
        e
      )
      return
    }

    // Inbound data may absorb older loose commits or lower-level
    // fragments. Compaction otherwise only runs after a *local* save
    // (via `#saveNewCommits`), so peer-pushed fragments that subsume
    // our existing on-disk state would leave the now-defunct records
    // on disk indefinitely.
    this.#scheduleCompaction(entry)

    // If the query was previously marked unavailable (e.g. sync completed
    // before data arrived), re-trigger a recompute so the query detects the
    // newly-loaded heads and transitions to "ready". Fired once per flush.
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
      syncSettled: Promise.resolve(),
      lastSavedHeads: new Set(),
      knownHashes: new Set(),
      persistedCommitHashes: new Set(),
      persistedFragmentHashes: new Set(),
      compactionInFlight: null,
      flushSave: throttledSave,
      saveSettled,
      saveInProgress: false,
      saveDeltaPending: false,
      lastSaveError: null,
      pendingInbound: [],
      inboundFlushScheduled: false,
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

    // Seed `persistedCommitHashes` / `persistedFragmentHashes` from
    // what's already on disk so the first compaction pass can clean
    // up defunct records left over from a previous process. Without
    // this, the sets would only ever reflect saves observed by this
    // process; data hydrated from disk would be invisible to
    // compaction even though it may be defunct relative to the
    // current minimal sedimentree.
    void (async () => {
      try {
        const entry = this.#entries.get(sidStr)
        if (!entry) return
        const [commitIds, fragmentIds] = await Promise.all([
          this.#storage.listCommitIds(sid),
          this.#storage.listFragmentIds(sid),
        ])
        for (const c of commitIds) {
          entry.persistedCommitHashes.add(c.toHexString())
        }
        for (const f of fragmentIds) {
          entry.persistedFragmentHashes.add(f.toHexString())
        }
        if (
          entry.persistedCommitHashes.size > 0 ||
          entry.persistedFragmentHashes.size > 0
        ) {
          // Kick compaction for defunct on-disk records. `#compactAbsorbed`
          // defers while `syncState === "initializing"`; the pass after
          // `#loadBlobsAndTransition` hydrates the handle.
          this.#scheduleCompaction(entry)
        }
      } catch (e) {
        this.#log(
          `failed to seed persistedHashes for ${sidStr.slice(0, 8)}: %O`,
          e
        )
      }
    })()

    this.#scheduleRecompute(this.#entries.get(sidStr))
  }

  detach(_documentId: DocumentId): void {}

  shareConfigChanged(): void {
    for (const entry of this.#entries.values()) {
      if (entry.lastSyncResult === "all-failed" && !entry.syncInFlight) {
        entry.lastSyncResult = null
        this.#scheduler.resetHealState(entry.sedimentreeId.toString())
      }
    }
    this.#scheduleRecompute()
  }

  // ── Central recompute ───────────────────────────────────────────────

  #recomputeScheduled = false
  /** Entries (by sidStr) whose state changed since the last walk started. */
  #recomputeDirty = new Set<string>()
  /** When set, the next walk visits every entry, ignoring the dirty set. */
  #recomputeAllDirty = false

  /**
   * Request a recompute of an entry's sync state machine — or of every
   * entry when no `entry` is given (connection-level events: a peer
   * connecting or an adapter transitioning changes `noPeersButConnection
   * Changed` for all entries at once).
   *
   * Coalesces bursts. Bulk `attach` (thousands of docs created/found at
   * once) previously called the *synchronous* `#recompute` once per doc,
   * and each call walked ALL entries — O(N²) synchronous work that
   * monopolized the single thread and starved the transport, so the sync
   * server's keepalive reaped the connection mid-ingest. A burst now
   * collapses to a single walk on the next macrotask, and the walk yields
   * periodically so the loop can service the socket between entries.
   *
   * Targeting matters for the same reason on the *settle* side: each
   * entry's save/sync completion lands in its own macrotask wave, so
   * per-completion full walks made flushing N documents O(N²) — one
   * O(N) walk per completion (measured ~4× per doc-count doubling;
   * see test/subduction/AttachStorm.test.ts). Per-entry state changes
   * only ever affect that entry's next transition (`#recomputeEntry`
   * reads the entry plus global connection state), so completions mark
   * just their entry dirty and a settle wave costs O(dirty), not O(N).
   */
  #scheduleRecompute(entry?: SedimentreeEntry) {
    // No new background sync rounds during shutdown — the quiesce pass
    // in `shutdown()` is the only thing allowed to initiate syncs.
    if (this.#shuttingDown) return

    if (entry === undefined) {
      this.#recomputeAllDirty = true
    } else if (!this.#recomputeAllDirty) {
      this.#recomputeDirty.add(entry.sedimentreeId.toString())
    }

    if (this.#recomputeScheduled) return
    this.#recomputeScheduled = true
    void (async () => {
      try {
        // Defer to a macrotask so a synchronous burst of attaches/transitions
        // collapses into one walk instead of one walk per attach.
        await yieldToMacrotask()
        this.#recomputeScheduled = false
        await this.#runRecompute()
      } catch (e) {
        this.#log("recompute walk failed: %O", e)
      }
    })()
  }

  /**
   * Walks can overlap: `#recomputeScheduled` resets *before* the walk runs
   * (so a request arriving mid-walk isn't lost), which means a second walk
   * may start while a prior one is suspended at `maybeYield()`. This is
   * safe only because `#recomputeEntry` is fully synchronous and guards
   * its async kick-offs with flags set in the same synchronous block
   * (`syncInFlight`, `blobLoadInFlight`). Keep it that way: making
   * `#recomputeEntry` async, or setting those flags after an `await`,
   * turns overlapping walks into double-dispatch bugs.
   *
   * The dirty set is snapshotted (and cleared) synchronously at walk
   * start for the same reason: entries dirtied mid-walk belong to the
   * next scheduled walk, never to this one.
   */
  async #runRecompute() {
    const maybeYield = makeYielder()

    if (this.#recomputeAllDirty) {
      this.#recomputeAllDirty = false
      this.#recomputeDirty.clear()
      for (const entry of [...this.#entries.values()]) {
        this.#recomputeEntry(entry)
        await maybeYield()
      }
      return
    }

    const dirty = [...this.#recomputeDirty]
    this.#recomputeDirty.clear()
    for (const sidStr of dirty) {
      const entry = this.#entries.get(sidStr)
      if (entry === undefined) continue
      this.#recomputeEntry(entry)
      await maybeYield()
    }
  }

  #recomputeEntry(entry: SedimentreeEntry) {
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
            Automerge.getHeads(entry.handle.fullDoc()).length === 0 &&
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

  async #doSync(entry: SedimentreeEntry, timeoutMs?: number | null) {
    const { sedimentreeId } = entry
    const sid = sedimentreeId.toString().slice(0, 8)
    entry.lastSyncGeneration = this.#connectionGeneration()

    let resolveSyncSettled!: () => void
    entry.syncSettled = new Promise<void>(r => {
      resolveSyncSettled = r
    })

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
        timeoutMs !== undefined ? timeoutMs : this.#syncTimeout
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
      //
      // During "initializing", `#loadBlobsAndTransition` performs one
      // atomic getBlobs + loadIncremental after sync succeeds; loading
      // here too would duplicate storage reads on first open.
      if (dataReceived && entry.syncState === "running") {
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
      resolveSyncSettled()
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
      this.#scheduleRecompute(entry)
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
      } blob(s), ${totalBytes} bytes, heads=${
        Automerge.getHeads(entry.handle.fullDoc()).length
      }`
    )
    if (!allBlobs || allBlobs.length === 0) return false
    allBlobs.sort((a, b) => b.byteLength - a.byteLength)

    let toApply = allBlobs
    if (this.#blobInterceptor) {
      const transformed: Uint8Array[] = []
      for (const blob of allBlobs) {
        const result = await this.#blobInterceptor.transformIncoming(
          entry.query.documentId,
          blob
        )
        if (result) transformed.push(result)
      }
      toApply = transformed
    }

    // Apply in cumulative-size chunks with a yield between them. A single
    // `loadIncremental` of a large cold-start doc (e.g. 1.5 MB / hundreds
    // of blobs) blocks the thread for >1s — in a service worker that
    // starves the socket and rendering; in Node it misses keepalive pongs.
    // `loadIncremental` tolerates partial/incremental application (live
    // sync relies on exactly that), so a subset of blobs is a valid
    // increment. A doc that fits in one chunk is a single update —
    // byte-for-byte the prior behavior, so the common small-doc path is
    // unchanged (and avoids re-triggering the per-update listener storm).
    const CHUNK_BYTES = 256 * 1024
    if (toApply.length > 0) {
      const total = toApply.reduce((n, b) => n + b.byteLength, 0)
      if (toApply.length === 1 || total <= CHUNK_BYTES) {
        const merged = toApply.length === 1 ? toApply[0] : mergeArrays(toApply)
        entry.handle.update(d => Automerge.loadIncremental(d, merged))
      } else {
        const maybeYield = makeYielder()
        let chunk: Uint8Array[] = []
        let chunkBytes = 0
        const flushChunk = () => {
          if (chunk.length === 0) return
          const merged = chunk.length === 1 ? chunk[0] : mergeArrays(chunk)
          entry.handle.update(d => Automerge.loadIncremental(d, merged))
          chunk = []
          chunkBytes = 0
        }
        for (const blob of toApply) {
          chunk.push(blob)
          chunkBytes += blob.byteLength
          if (chunkBytes >= CHUNK_BYTES) {
            flushChunk()
            await maybeYield()
          }
        }
        flushChunk()
      }
    }

    // The bulk-loaded blobs may include fragments that absorb loose
    // commits also persisted on disk, or earlier fragments superseded
    // by later ones. Schedule a compaction pass so the storage view
    // converges with the now-applied minimal sedimentree.
    this.#scheduleCompaction(entry)

    return true
  }

  async #loadBlobsAndTransition(entry: SedimentreeEntry) {
    try {
      const subduction = await this.#subduction
      await this.#loadBlobsIntoHandle(entry, subduction)

      entry.syncState = "running"

      if (Automerge.getHeads(entry.handle.fullDoc()).length === 0) {
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
      this.#scheduleRecompute(entry)
    }
  }

  // ── Saving local changes to subduction ──────────────────────────────

  /**
   * Persist any new local commits for `entry` into Subduction.
   *
   * Persistence only — propagation to peers happens via the `#doSync`
   * arm in the tail below, never inline. `saveSettled` therefore
   * gates on local durability alone; in particular `shutdown()` can
   * await it without waiting out network round-trip deadlines.
   *
   * Single-flight per entry: concurrent invocations early-return on
   * the `saveInProgress` gate (no promise-chain queue). Each pass
   * processes whatever has accumulated since `entry.lastSavedHeads`
   * and runs at most one `storeBuiltBatch` write; if the post-await
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
      const doc = entry.handle.fullDoc()
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

      const subduction = await this.#subduction
      const sid = entry.sedimentreeId.toString().slice(0, 8)
      if (this.#log.enabled) {
        this.#log(
          `#save ${sid}: state=${entry.syncState}, ` +
            `syncInFlight=${entry.syncInFlight}`
        )
      }

      let result: { prepFailures: number }
      try {
        result = await this.#saveNewCommits(entry, doc, subduction)
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

    // Trigger immediate sync to peers — this is the ONLY broadcast
    // path for newly saved commits (`#saveNewCommits` is store-only).
    // If a sync is already in flight, flag for re-sync when it
    // completes (otherwise the in-flight sync would overwrite
    // lastSyncResult and the new commits would be lost).
    //
    // During shutdown this state is still recorded — the quiesce pass
    // in `shutdown()` uses it to find entries with un-broadcast
    // commits — but `#scheduleRecompute` itself is a no-op then, so
    // no new background sync rounds spin up.
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
    this.#scheduleRecompute(entry)
  }

  async #saveNewCommits<T>(
    entry: SedimentreeEntry,
    doc: Automerge.Doc<T>,
    subduction: Subduction
  ): Promise<{ prepFailures: number }> {
    // Ask the doc directly for its level-0 loose commits and its
    // higher-level fragments. Automerge core owns the compaction
    // policy (which commits get absorbed into which fragments); we
    // just mirror that view into subduction. Once a fragment forms,
    // its component commits stop appearing at level 0 and the
    // fragment itself appears at level ≥ 1 — so the wire-level
    // forward switches from "N LooseCommits" to "one Fragment bundle"
    // automatically.
    //
    // We deliberately avoid `Automerge.getCommits` / `getFragments`
    // here: those eagerly bundle the bytes for EVERY commit and
    // fragment in the doc, and bundling is O(N) per item — so calling
    // them on every throttled save gives O(N × #items) work on each
    // tick, of which we then throw 99% away by filtering against
    // `knownHashes`. At ~12k changes that's ~30 s of wasted bundle
    // work per tick, and the resulting allocation churn inside
    // automerge_wasm reliably overflows its 4 GiB linear-memory heap
    // (panics in `slab/writer.rs` / `change/collector.rs`) somewhere
    // around 12k–15k changes.
    //
    // Instead, we read just the metadata (cheap: a few ms even at
    // 12k changes), filter against `knownHashes` first, and bundle
    // only the small handful of newly-formed commits/fragments per
    // tick. See proposals/bundle-fragments-single-walk.md for the
    // matching automerge-core fix.
    const commitMetas = Automerge.getFragmentMetadata(doc, 0)
    const fragmentMetas = Automerge.getFragmentMetadata(doc, { start: 1 })

    const newCommitMetas = commitMetas.filter(
      m => !entry.knownHashes.has(m.head)
    )
    const newFragmentMetas = fragmentMetas.filter(
      m => !entry.knownHashes.has(m.head)
    )

    if (newCommitMetas.length === 0 && newFragmentMetas.length === 0) {
      return { prepFailures: 0 }
    }

    const newCommitBytes =
      newCommitMetas.length === 0
        ? []
        : Automerge.bundleFragmentMetadata(doc, newCommitMetas)
    const newFragmentBytes =
      newFragmentMetas.length === 0
        ? []
        : Automerge.bundleFragmentMetadata(doc, newFragmentMetas)

    const newCommits = newCommitMetas.map((m, i) => ({
      head: m.head,
      parents: m.boundary,
      bytes: newCommitBytes[i],
    }))
    const newFragments = newFragmentMetas.map((m, i) => ({
      head: m.head,
      boundary: m.boundary,
      checkpoints: m.checkpoints,
      bytes: newFragmentBytes[i],
    }))

    const acceptedHashes: string[] = []
    const commitInputs: CommitInput[] = []
    const fragmentInputs: FragmentInput[] = []
    const prepErrors: unknown[] = []

    // Yield between input-prep iterations so a large batch (e.g. a 1000+
    // commit propagation) doesn't build all its CommitInputs/FragmentInputs
    // in one unbroken run.
    const maybeYield = makeYielder()

    const documentId = entry.query.documentId
    for (const c of newCommits) {
      try {
        let commitBytes = c.bytes
        if (this.#blobInterceptor) {
          commitBytes = await this.#blobInterceptor.transformOutgoing(
            documentId,
            commitBytes
          )
        }
        const head = CommitId.fromHexString(c.head)
        const looseCommit = new LooseCommit(
          entry.sedimentreeId,
          head,
          c.parents.map(p => CommitId.fromHexString(p)),
          new BlobMeta(commitBytes)
        )
        commitInputs.push(new CommitInput(looseCommit, commitBytes))
        acceptedHashes.push(c.head)
      } catch (e) {
        console.warn(
          `[SubductionSource] commit input prep failed for ${c.head}:`,
          e
        )
        prepErrors.push(e)
      }
      await maybeYield()
    }

    for (const f of newFragments) {
      try {
        let fragmentBytes = f.bytes
        if (this.#blobInterceptor) {
          fragmentBytes = await this.#blobInterceptor.transformOutgoing(
            documentId,
            fragmentBytes
          )
        }
        const head = CommitId.fromHexString(f.head)
        const boundary = f.boundary.map(b => CommitId.fromHexString(b))
        const checkpoints = f.checkpoints.map(c => CommitId.fromHexString(c))
        const fragment = new Fragment(
          entry.sedimentreeId,
          head,
          boundary,
          checkpoints,
          new BlobMeta(fragmentBytes)
        )
        fragmentInputs.push(new FragmentInput(fragment, fragmentBytes))
        acceptedHashes.push(f.head)
      } catch (e) {
        console.warn(
          `[SubductionSource] fragment input prep failed for ${f.head}:`,
          e
        )
        prepErrors.push(e)
      }
      await maybeYield()
    }

    if (prepErrors.length > 0) {
      entry.lastSaveError =
        prepErrors.length === 1
          ? prepErrors[0]
          : new AggregateError(
              prepErrors,
              `${prepErrors.length} inputs failed to prepare`
            )
    }

    if (commitInputs.length === 0 && fragmentInputs.length === 0) {
      return { prepFailures: prepErrors.length }
    }

    // Record hashes BEFORE `storeBuiltBatch` so the synchronous
    // `commit-saved` / `fragment-saved` events fired from the storage
    // bridge (which run before `storeBuiltBatch` resolves) find them
    // and skip the `#handleDataFound` apply path.
    for (const hash of acceptedHashes) entry.knownHashes.add(hash)

    try {
      // Store-only tier (no broadcast). `addBatch` would also run a
      // `sync_with_all_peers` round-trip, but that's redundant — the
      // `#save` tail arms an immediate `#doSync` (which does its own
      // `syncWithAllPeers`) — and it made `saveSettled` hostage to
      // network round-trip deadlines: post-convergence broadcasts hit
      // the full 30 s Wasm deadline, stalling `shutdown()` (which
      // awaits `saveSettled`) ~25–30 s on every online run.
      await subduction.storeBuiltBatch(
        entry.sedimentreeId,
        commitInputs,
        fragmentInputs
      )
    } catch (e) {
      // On failure, roll the set entries back so the next save can
      // retry. `#save` separately keeps `entry.lastSavedHeads` at its
      // previous value when this rejects.
      for (const hash of acceptedHashes) entry.knownHashes.delete(hash)
      console.warn(
        `[SubductionSource] storeBuiltBatch failed for ${entry.sedimentreeId
          .toString()
          .slice(0, 8)} (${commitInputs.length} commits, ` +
          `${fragmentInputs.length} fragments):`,
        e
      )
      throw e
    }

    this.#scheduleCompaction(entry)

    return { prepFailures: prepErrors.length }
  }

  /**
   * Kick off a compaction pass without blocking the save loop.
   *
   * Compaction is purely a storage-side garbage collection; nothing
   * downstream of `#saveNewCommits` (the throttled save, the sync
   * scheduler, peers awaiting propagation) cares whether the
   * already-absorbed commits are still on disk. So we deliberately
   * don't await it — the next save returns as soon as `storeBuiltBatch`
   * resolves, and the deletes drain at whatever pace the adapter
   * allows. Errors are logged but never propagated up; if a delete
   * fails the data sticks around until the next pass tries again.
   */
  #scheduleCompaction(entry: SedimentreeEntry): void {
    if (entry.compactionInFlight) return
    const p = this.#compactAbsorbed(entry).finally(() => {
      if (entry.compactionInFlight === p) entry.compactionInFlight = null
    })
    entry.compactionInFlight = p
  }

  /**
   * Delete on-disk records for commits and fragments that automerge
   * core has absorbed into higher-level fragments. Without this
   * subduction's storage grows roughly with `total history written`
   * rather than with `current minimal sedimentree`, since the wasm
   * `Subduction.storeBuiltBatch` writes new records but never deletes the
   * ones they supersede.
   *
   * We use automerge as the source of truth: any persisted hash that
   * is no longer in `getCommits` / `getFragments` is by definition
   * absorbed and safe to drop. Subduction core has already minimized
   * its in-memory tree at the end of `storeBuiltBatch`, so this only ever
   * removes data that is provably redundant on the local node.
   *
   * IMPORTANT: we sample `handle.doc()` here rather than reusing the
   * snapshot from the save loop. Under concurrent writes the handle
   * may have advanced between `storeBuiltBatch` and this call; deleting
   * against a stale snapshot would clobber freshly-persisted commits
   * that are still live at the level-0 layer, forcing the next save
   * to re-persist them and (a) wasting I/O, (b) inflating apparent
   * disk usage. Using the current handle snapshot is monotonic: a
   * commit reported by `getCommits` now will never go un-absorbed
   * later, so the diff is always a strict subset of garbage.
   *
   * Callers shouldn't invoke this directly — go through
   * `#scheduleCompaction` so overlapping passes don't pile up.
   */
  async #compactAbsorbed(entry: SedimentreeEntry): Promise<void> {
    if (
      entry.persistedCommitHashes.size === 0 &&
      entry.persistedFragmentHashes.size === 0
    ) {
      return
    }

    // Sync writes commits to storage (and records them in
    // `persistedCommitHashes`) before the handle is hydrated:
    // `#handleDataFound` is skipped during "initializing", and
    // `#loadBlobsAndTransition` performs the atomic first load.
    // Comparing an empty handle against those hashes would delete
    // live data that `getBlobs` still needs.
    if (entry.syncState === "initializing" || entry.blobLoadInFlight) {
      return
    }

    const doc = entry.handle.doc()
    if (!doc) return

    if (
      Automerge.getHeads(doc).length === 0 &&
      (entry.persistedCommitHashes.size > 0 ||
        entry.persistedFragmentHashes.size > 0)
    ) {
      return
    }

    // Metadata-only: we just need the hashes to compute the stale
    // set, so avoid `getCommits` / `getFragments` which would
    // re-bundle every item (O(N × #items) wasted work per compaction
    // pass — same trap that bit `#saveNewCommits`).
    const liveCommits = new Set<string>(
      Automerge.getFragmentMetadata(doc, 0).map(m => m.head)
    )
    const liveFragments = new Set<string>(
      Automerge.getFragmentMetadata(doc, { start: 1 }).map(m => m.head)
    )

    const staleCommits: string[] = []
    for (const hex of entry.persistedCommitHashes) {
      if (!liveCommits.has(hex)) staleCommits.push(hex)
    }
    const staleFragments: string[] = []
    for (const hex of entry.persistedFragmentHashes) {
      if (!liveFragments.has(hex)) staleFragments.push(hex)
    }

    if (staleCommits.length === 0 && staleFragments.length === 0) return

    const sid = entry.sedimentreeId
    const ops: Array<Promise<unknown>> = []
    for (const hex of staleCommits) {
      ops.push(this.#storage.deleteCommit(sid, CommitId.fromHexString(hex)))
    }
    for (const hex of staleFragments) {
      ops.push(this.#storage.deleteFragment(sid, CommitId.fromHexString(hex)))
    }

    try {
      await Promise.all(ops)
      for (const hex of staleCommits) entry.persistedCommitHashes.delete(hex)
      for (const hex of staleFragments)
        entry.persistedFragmentHashes.delete(hex)
      this.#log(
        `compacted ${sid.toString().slice(0, 8)}: -${
          staleCommits.length
        } commits, -${staleFragments.length} fragments`
      )
    } catch (e) {
      // A failed delete just means the data sticks around until the
      // next compaction attempt; nothing breaks on the read side
      // because automerge will simply re-apply the redundant bytes.
      this.#log(`compaction failed for ${sid.toString().slice(0, 8)}: %O`, e)
    }
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

    // Drain queued inbound blobs synchronously so any pending
    // peer-delivered changes are applied to the handle before
    // `#saveNewCommits` walks the doc. Without this, getCommits/heads
    // would lag behind what subduction has already stored.
    for (const entry of targets) this.#flushInbound(entry)

    // Bounded so pathological mutation patterns can't trap `flush()`
    // forever.
    const MAX_FLUSH_ROUNDS = 8
    for (let round = 0; round < MAX_FLUSH_ROUNDS; round++) {
      // 1. Drain any in-flight commits.
      for (const entry of targets) entry.flushSave.flush()
      await Promise.all(targets.map(e => e.saveSettled))

      // 2. Stable iff no entry's save was re-armed by a delta
      //    detected after the await resolved.
      const anyPending = targets.some(e => e.saveDeltaPending)
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

    // Drain any in-flight compaction passes so callers observing the
    // post-flush storage state see the deletes that the save loop
    // kicked off but didn't await. Compaction can re-arm itself
    // (a new pass starts during the await); bound the loop so a
    // pathological burst can't trap us here.
    const MAX_COMPACT_ROUNDS = 4
    for (let round = 0; round < MAX_COMPACT_ROUNDS; round++) {
      const inFlight = targets
        .map(e => e.compactionInFlight)
        .filter((p): p is Promise<void> => p !== null)
      if (inFlight.length === 0) break
      await Promise.all(inFlight)
    }
  }

  // ── Shutdown ────────────────────────────────────────────────────────

  async shutdown() {
    this.#shuttingDown = true

    // 1. Stop reconnect loops and prevent new transports
    for (const mgr of this.#connectionManagers) {
      mgr.shutdown()
    }

    // 2. Stop any pending heal-retry timers and prevent new schedules
    this.#scheduler.shutdown()

    // 3a. Drain any queued inbound blobs synchronously so the handle
    //     is consistent with what subduction has on disk.
    for (const entry of this.#entries.values()) this.#flushInbound(entry)

    // 3b. Flush all pending throttled saves so they start executing
    for (const entry of this.#entries.values()) {
      entry.flushSave.flush()
    }

    // 4. Wait for all in-flight #save() calls to complete. Saves are
    //    store-only (no broadcast), so this settles at disk speed.
    await Promise.all(
      Array.from(this.#entries.values()).map(e => e.saveSettled)
    )

    // 4b. Quiesce outbound propagation. First let any in-flight
    //     `#doSync` rounds finish (their responses still route — the
    //     transports stay up until step 6)...
    await Promise.all(
      Array.from(this.#entries.values()).map(e => e.syncSettled)
    )

    //     ...then run one final sync round for every entry whose
    //     saved commits were never broadcast (`#save`'s tail recorded
    //     the dirty state but `#scheduleRecompute` was a no-op). This
    //     is what was previously — accidentally — covered by the
    //     blocking broadcast inside `addBatch`: without it, anything
    //     pushed shortly before shutdown is durable locally but never
    //     reaches the server, and short-lived CLI processes lose data.
    const unbroadcast = Array.from(this.#entries.values()).filter(
      e => e.needsResync || e.lastSyncResult === null
    )
    if (unbroadcast.length > 0) {
      this.#log(
        `shutdown: final sync round for ${unbroadcast.length} ` +
          `entr${unbroadcast.length === 1 ? "y" : "ies"} with ` +
          `un-broadcast commits`
      )
      // Bounded pool: a large dirty set must not open hundreds of
      // concurrent sync rounds against a single (possibly
      // single-threaded) server.
      const queue = [...unbroadcast]
      const workers = Array.from(
        { length: Math.min(16, queue.length) },
        async () => {
          for (;;) {
            const e = queue.pop()
            if (e === undefined) return
            try {
              // Short deadline: a final best-effort push must not pin
              // shutdown on an unresponsive (or already torn down)
              // peer for the full sync timeout.
              await this.#doSync(e, SHUTDOWN_SYNC_TIMEOUT_MS)
            } catch (err) {
              this.#log(
                "shutdown: final sync failed for %s: %O",
                e.sedimentreeId.toString().slice(0, 8),
                err
              )
            }
          }
        }
      )
      await Promise.all(workers)
    }

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
}
