import * as N from "@automerge/subduction/slim"
import {
  BackendError,
  commitId,
  copyRecord,
  equalRecords,
  recordBytes,
  sedimentreeId,
  type BackendIdentity,
  type BackendOperation,
  type HistoryMarker,
  type LooseCommitRecord,
  type SedimentreeRecord,
  type RecordBatch,
  type SedimentreeBackend,
  type SedimentreeEvent,
  type SedimentreeId,
  type SedimentreeSession,
  type SyncRoundResult,
} from "@automerge/automerge-repo/sedimentree"
import {
  StorageBridge,
  nativeId,
  logicalId,
  storedRecord,
  unsigned,
  unsignedFragment,
} from "./storage.js"
import type { ByteStore } from "./ByteStore.js"
import { Watch } from "./watch.js"
import { notifyBackendClosed } from "./backendLifecycle.js"
import {
  copyEphemeral,
  decodeEphemeral,
  encodeEphemeral,
  rememberEphemeral,
  topicKey,
} from "./ephemeral.js"

export type { ByteStore } from "./ByteStore.js"
export { MemoryByteStore } from "./MemoryByteStore.js"
export { IndexedDBByteStore } from "./IndexedDBByteStore.js"
export { connectSubductionServer } from "./connect.js"
export type {
  SubductionServer,
  SubductionConnection,
  SubductionConnectionStatus,
  SubductionConnectionOptions,
} from "./connect.js"
export { createSubductionPeer } from "./peer.js"
export type { SubductionPeer, SubductionPeerOptions } from "./peer.js"
/** Borrowed: keep alive through backend.close(). Requires a valid Ed25519
 * verifying key and matching signatures; native does not validate providers safely.
 */
export type NativeSigner = N.Signer
/** Authenticate outside the backend; addConnection borrows this wrapper. */
export type AuthenticatedTransport = N.AuthenticatedTransport

interface EngineGeneration {
  /** Accepts new work. */
  active: boolean
  /** Storage revoked; set once accepted work has settled. */
  sealed: boolean
  stopping?: Promise<void>
  work: Set<Promise<unknown>>
  interests: Set<SedimentreeId>
}

export interface SubductionBackendOptions {
  signer: NativeSigner
  storage: ByteStore
  /** Native request deadline, not a deadline on local storage or handshake. */
  syncTimeoutMilliseconds?: number
  replayEvents?: number
  replayBytes?: number
}

function error(
  operation: BackendOperation,
  cause: unknown,
  terminal = false
): BackendError {
  if (cause instanceof BackendError)
    return new BackendError(
      operation,
      cause.code,
      cause.message,
      !terminal && cause.retryable,
      { cause }
    )
  return new BackendError(operation, "io", String(cause), !terminal, { cause })
}
function copyEvent(value: SedimentreeEvent): SedimentreeEvent {
  if (value.type === "ephemeral")
    return {
      ...value,
      message: copyEphemeral(value.message),
      sender: { ...value.sender, path: [...value.sender.path] },
    }
  if (value.type === "records" || value.type === "blobs")
    // Each session's native stream yields its own JS copies of stored bytes,
    // and an event is delivered to only that session.
    return value
  if (value.type === "history-marker" || value.type === "local-load-complete")
    return value.marker
      ? {
          ...value,
          marker: { ...value.marker, heads: [...value.marker.heads] },
        }
      : { ...value }
  if (value.type === "synchronized")
    return {
      ...value,
      result: {
        ...value.result,
        marker: {
          ...value.result.marker,
          heads: [...value.result.marker.heads],
        },
        peers: value.result.peers.map(p => ({
          ...p,
          peer: { ...p.peer, path: [...p.peer.path] },
        })),
      },
    }
  if (value.type === "remote-heads")
    return {
      ...value,
      remote: { ...value.remote, path: [...value.remote.path] },
      heads: [...value.heads],
    }
  return { ...value }
}
function waitOnly<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  return new Promise<T>((resolve, reject) => {
    const abort = () =>
      reject(signal.reason ?? new Error("Synchronization wait aborted"))
    if (signal.aborted) abort()
    else signal.addEventListener("abort", abort, { once: true })
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort))
  })
}

/** EXPERIMENTAL: real WASM persistence and authenticated peer sync.
 * Initialize Subduction WASM before construction. Storage is exclusively owned.
 */
export class SubductionBackend implements SedimentreeBackend {
  private readonly limits: Required<
    Omit<SubductionBackendOptions, "signer" | "storage">
  >
  private readonly bridge: StorageBridge
  private engine: N.Subduction
  private generation!: EngineGeneration
  /** Settles once an in-progress engine replacement (delete/close) has. */
  private replacing: Promise<unknown> = Promise.resolve()
  /** Deletions replace the whole engine, so they run one at a time. */
  private deleteTail: Promise<unknown> = Promise.resolve()
  private closed = false
  private closing?: Promise<void>
  private sequence = 0
  private round = 0
  private readonly deleting = new Map<SedimentreeId, Promise<void>>()
  private readonly watches = new Map<Watch<SedimentreeEvent>, SedimentreeId>()
  /** One automatic reopen per document until a live update succeeds. */
  private readonly recovering = new Set<SedimentreeId>()
  /** Sessions whose consumer verified a complete snapshot (markComplete). */
  private readonly completed = new Set<Watch<SedimentreeEvent>>()
  private readonly attempts = new Set<{
    id: SedimentreeId
    work: Promise<void>
  }>()
  private readonly signer: NativeSigner
  private readonly seenEphemerals = new Set<string>()
  private readonly self: string

  constructor(options: SubductionBackendOptions) {
    this.signer = options.signer
    const self = new N.PeerId(options.signer.verifyingKey())
    try {
      this.self = self.toString()
    } finally {
      self.free()
    }
    this.limits = {
      syncTimeoutMilliseconds: options.syncTimeoutMilliseconds ?? 5000,
      replayEvents: options.replayEvents ?? 128,
      replayBytes: options.replayBytes ?? 4 * 1024 * 1024,
    }
    for (const value of Object.values(this.limits))
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new TypeError("Limits must be positive safe integers")
    if (this.limits.syncTimeoutMilliseconds > 0xffffffff)
      throw new TypeError("Sync timeout exceeds native u32 range")
    this.bridge = new StorageBridge(options.storage)
    this.engine = this.createEngine()
  }
  private createEngine(): N.Subduction {
    const generation: EngineGeneration = {
      active: true,
      sealed: false,
      work: new Set(),
      interests: new Set(),
    }
    this.generation = generation
    // Native listener tasks can outlive disconnectAll/free. Each engine gets a
    // revocable view; old tasks must never enter a new storage generation.
    const storage = new Proxy(this.bridge, {
      get(target, key) {
        const value = Reflect.get(target, key)
        if (typeof value !== "function") return value
        return (...args: unknown[]) => {
          if (generation.sealed)
            return Promise.reject(
              new Error("Retired Subduction storage generation")
            )
          return Reflect.apply(value, target, args)
        }
      },
    })
    // opts.signer is a JS Signer reference, NOT a consumed WASM pointer.
    return new N.Subduction({
      signer: this.signer,
      storage,
      defaultTimeoutMilliseconds: this.limits.syncTimeoutMilliseconds,
      onEphemeral: (topic: N.Topic, peer: N.PeerId, bytes: Uint8Array) => {
        try {
          if (
            !generation.active ||
            generation.stopping ||
            this.closed ||
            peer.toString() === this.self
          )
            return
          const key = topicKey(topic.toBytes())
          const tree = sedimentreeId(
            key.endsWith("0".repeat(32)) ? key.slice(0, 32) : key
          )
          if (this.deleting.has(tree)) return
          const watches = [...this.watches].filter(
            ([watch, id]) => id === tree && watch.active
          )
          if (!watches.length) return
          const message = decodeEphemeral(bytes)
          if (
            !message ||
            !rememberEphemeral(
              this.seenEphemerals,
              `${key}:${message.messageId}`
            )
          )
            return
          const event: SedimentreeEvent = {
            type: "ephemeral",
            sequence: ++this.sequence,
            message,
            sender: this.peerIdentity(peer),
          }
          for (const [watch] of watches)
            watch.push(event, bytes.byteLength, true)
        } finally {
          peer.free()
          topic.free()
        }
      },
      onRemoteHeads: (
        id: N.SedimentreeId,
        peer: N.PeerId,
        heads: N.CommitId[]
      ) => {
        try {
          if (!generation.active || generation.stopping || this.closed) return
          const tree = logicalId(id)
          if (this.deleting.has(tree)) return
          const event: SedimentreeEvent = {
            type: "remote-heads",
            sequence: ++this.sequence,
            remote: this.peerIdentity(peer),
            heads: heads.map(h => commitId(h.toHexString())),
          }
          for (const [watch, watched] of this.watches)
            if (watched === tree) watch.push(event, 96 + heads.length * 32)
        } finally {
          heads.forEach(h => h.free())
          peer.free()
          id.free()
        }
      },
    })
  }
  private peerIdentity(peer: N.PeerId): BackendIdentity {
    return { kind: "subduction", id: peer.toString(), path: [] }
  }
  private checkNetwork(
    generation: EngineGeneration,
    id?: SedimentreeId,
    operation: BackendOperation = "synchronize"
  ): void {
    this.check(operation, id)
    if (!generation.active || generation.stopping)
      throw new BackendError(
        operation,
        "io",
        "Connection generation ended; reconnect explicitly",
        true
      )
  }
  private stopNetwork(): Promise<void> {
    return (this.generation.stopping ??= this.engine.disconnectAll())
  }
  private async retireEngine(): Promise<void> {
    const generation = this.generation
    generation.active = false
    const stopped = await Promise.allSettled([
      this.stopNetwork(),
      ...generation.work,
    ])
    generation.sealed = true
    // Ends this engine's stored streams; their sessions restart on the next.
    await this.engine.close()
    // Stream handlers may still hold engine calls; free only once they settle.
    while (generation.work.size) await Promise.allSettled([...generation.work])
    this.engine.free()
    // Failed syncs are reported to their callers/streams, not as close errors.
    if (stopped[0].status === "rejected") throw stopped[0].reason
  }
  private resetEngine(): Promise<void> {
    const reset = (async () => {
      try {
        await this.retireEngine()
      } finally {
        this.engine = this.createEngine()
        for (const id of new Set(this.watches.values()))
          this.reconcileInterest(id)
      }
    })()
    this.replacing = reset.catch(() => {})
    return reset
  }
  /** The live engine, waiting out a replacement in progress. */
  private async live(
    operation: BackendOperation,
    id?: SedimentreeId
  ): Promise<{ engine: N.Subduction; generation: EngineGeneration }> {
    for (;;) {
      this.check(operation, id)
      if (this.generation.active)
        return { engine: this.engine, generation: this.generation }
      await this.replacing
    }
  }

  /** Borrow the authenticated wrapper until this promise settles. On success,
   * the engine owns a connection clone and disconnects it on close/reset/delete.
   * Keep the underlying JS transport alive until disconnection. Authentication
   * is the caller's responsibility; no document handle is materialized here.
   *
   * Open streams sync the new connection themselves, and native serves peer
   * requests for any stored tree, so stored-but-unopened documents are not
   * replayed here (matching Repo's historical connect behaviour).
   */
  addConnection(transport: AuthenticatedTransport): Promise<boolean> {
    try {
      const generation = this.generation
      const engine = this.engine
      this.checkNetwork(generation)
      return this.nativeWork(generation, async () => {
        const added = await engine.addConnection(transport)
        if (this.closed || !generation.active || generation.stopping) {
          await engine.disconnectAll()
          throw new BackendError(
            "synchronize",
            this.closed ? "closed" : "io",
            "Connection was superseded",
            !this.closed
          )
        }
        return added
      }).catch(cause => {
        throw error("synchronize", cause)
      })
    } catch (cause) {
      return Promise.reject(cause)
    }
  }
  private nativeWork<T>(
    generation: EngineGeneration,
    run: () => Promise<T>
  ): Promise<T> {
    const work = run()
    generation.work.add(work)
    void work.finally(() => generation.work.delete(work)).catch(() => {})
    return work
  }
  private reconcileInterest(id: SedimentreeId): void {
    const generation = this.generation
    const engine = this.engine
    if (!generation.active || generation.stopping || this.closed) return
    const desired =
      !this.deleting.has(id) &&
      [...this.watches].some(([watch, tree]) => tree === id && watch.active)
    if (desired === generation.interests.has(id)) return
    // Native may update its local interest before a control send fails.
    // Record the attempted state so a released observer still cleans up.
    if (desired) generation.interests.add(id)
    else generation.interests.delete(id)
    void this.nativeWork(generation, async () => {
      const native = nativeId(id)
      const topic = N.Topic.fromBytes(native.toBytes())
      native.free()
      try {
        if (desired) await engine.subscribeEphemeral([topic])
        else await engine.unsubscribeEphemeral([topic])
      } finally {
        topic.free()
      }
    }).catch(cause => {
      if (!generation.active || this.closed) return
      for (const [watch, tree] of this.watches)
        if (tree === id && watch.active)
          watch.push(
            {
              type: "failure",
              sequence: ++this.sequence,
              error: error("ephemeral", cause),
            },
            64,
            true
          )
    })
  }
  private network<T>(
    id: SedimentreeId,
    run: (engine: N.Subduction, generation: EngineGeneration) => Promise<T>
  ): Promise<T> {
    const generation = this.generation
    const engine = this.engine
    try {
      this.checkNetwork(generation, id)
    } catch (cause) {
      return Promise.reject(cause)
    }
    return this.nativeWork(generation, () => run(engine, generation))
  }
  /** Propagate a store without an open session; one round per store. */
  private scheduleSync(id: SedimentreeId, generation: EngineGeneration): void {
    if (
      this.closed ||
      this.deleting.has(id) ||
      generation !== this.generation ||
      generation.stopping
    )
      return
    void this.network(id, (engine, generation) =>
      this.syncRound(id, engine, generation)
    ).catch(cause => {
      if (!this.closed && generation.active && !this.deleting.has(id))
        for (const [watch, tree] of this.watches)
          if (tree === id)
            watch.push({
              type: "failure",
              sequence: ++this.sequence,
              error: error("synchronize", cause),
            })
    })
  }
  private async syncRound(
    id: SedimentreeId,
    engine: N.Subduction,
    generation: EngineGeneration,
    recipient?: Watch<SedimentreeEvent>
  ): Promise<SyncRoundResult> {
    this.check("synchronize", id)
    const roundId = `subduction-${++this.round}`
    const native = nativeId(id)
    let peers: N.PeerId[] = []
    try {
      peers = await engine.getConnectedPeerIds()
      // Store-triggered rounds only propagate; with no peers there is nothing
      // to do or report. Explicit rounds always answer their session.
      if (!peers.length && !recipient)
        return {
          roundId,
          marker: { sequence: ++this.sequence, heads: [] },
          outcome: "no-peers",
          peers: [],
        }
      const outcomes: SyncRoundResult["peers"][number][] = []
      for (const peer of peers) {
        const identity = this.peerIdentity(peer)
        try {
          const response = await engine.syncWithPeer(
            peer,
            native,
            true,
            this.limits.syncTimeoutMilliseconds
          )
          try {
            const failures = response.transportErrors
            outcomes.push({
              peer: identity,
              outcome: response.success ? "complete" : "failed",
              ...(failures.length
                ? {
                    error: error(
                      "synchronize",
                      new AggregateError(
                        failures,
                        "Peer synchronization failed"
                      )
                    ),
                  }
                : !response.success
                  ? {
                      error: new BackendError(
                        "synchronize",
                        "unsupported",
                        "Native sync does not distinguish absent, unauthorized, and disconnected peers"
                      ),
                    }
                  : {}),
            })
          } finally {
            response.free()
          }
        } catch (cause) {
          outcomes.push({
            peer: identity,
            outcome: "failed",
            error: error("synchronize", cause),
          })
        }
      }
      this.checkNetwork(generation, id)
      let result!: SyncRoundResult
      const publish = (marker: HistoryMarker) => {
        result = {
          roundId,
          marker,
          outcome: !peers.length
            ? "no-peers"
            : outcomes.every(p => p.outcome === "complete")
              ? "complete"
              : "failed",
          peers: outcomes,
        }
        if (!this.closed && !this.deleting.has(id))
          for (const [watch, tree] of this.watches)
            if (tree === id && (!recipient || watch === recipient))
              watch.push(
                { type: "synchronized", result },
                64 + result.marker.heads.length * 32 + outcomes.length * 128
              )
      }
      publish(await this.headsMarker(engine, native))
      return result
    } finally {
      peers.forEach(peer => peer.free())
      native.free()
    }
  }
  private check(operation: BackendOperation, id?: SedimentreeId): void {
    if (this.closed)
      throw new BackendError(operation, "closed", "Backend is closed")
    if (id && this.deleting.has(id))
      throw new BackendError(operation, "deleted", "Deletion barrier is active")
  }
  /** Stream items follow native's cache update, so native heads include them. */
  private async liveMarker(
    watch: Watch<SedimentreeEvent>,
    engine: N.Subduction,
    native: N.SedimentreeId
  ): Promise<void> {
    // Markers only establish readiness; completed sessions no longer need them.
    if (this.completed.has(watch)) return
    const target = await this.headsMarker(engine, native)
    watch.push(
      { type: "history-marker", marker: target },
      32 + target.heads.length * 32
    )
  }
  private async headsMarker(
    engine: N.Subduction,
    native: N.SedimentreeId
  ): Promise<HistoryMarker> {
    const heads = (await engine.getHeads(native)) ?? []
    try {
      return {
        sequence: ++this.sequence,
        heads: heads.map(head => commitId(head.toHexString())).sort(),
      }
    } finally {
      heads.forEach(head => head.free())
    }
  }
  open(input: SedimentreeId): SedimentreeSession {
    const id = sedimentreeId(input)
    this.check("open", id)
    let released = false
    let stream: N.StoredUpdates | undefined
    let initialized = false
    let resuming = false
    const watch = new Watch<SedimentreeEvent>(
      this.limits.replayEvents,
      this.limits.replayBytes,
      copyEvent,
      () => ({ type: "rescan-required", sequence: ++this.sequence }),
      () => {
        released = true
        stream?.close()
        this.watches.delete(watch)
        if (!resuming && ![...this.watches.values()].includes(id))
          this.recovering.delete(id)
        this.completed.delete(watch)
        this.reconcileInterest(id)
      }
    )
    // Keep sync and peer events that arrive while a first load waits on peers.
    watch.bufferBeforeInitialize()
    this.watches.set(watch, id)
    // Each engine owns one stream that keeps syncing across connections.
    const observe = async (): Promise<void> => {
      this.check("open", id)
      if (released) return
      const { engine, generation } = await this.live("open", id)
      if (released) return
      const native = nativeId(id)
      const updates = engine.loadAndWatch(native)
      stream = updates
      // Engine calls from this loop must settle before retirement frees it.
      const marker = () =>
        this.nativeWork(generation, () =>
          this.liveMarker(watch, engine, native)
        )
      // Only storage scans are batched; peer and local updates flow live.
      let snapshot: Uint8Array[] | undefined = []
      const deliver = async (noPeers = false) => {
        const blobs = snapshot!
        snapshot = undefined
        if (!initialized) {
          initialized = true
          const sequence = ++this.sequence
          watch.initialize([
            ...(blobs.length
              ? [{ type: "blobs" as const, sequence, blobs }]
              : []),
            {
              type: "local-load-complete",
              found: blobs.length > 0,
              backendSyncs: true,
              ...(noPeers ? { noPeers: true } : {}),
            },
          ])
          this.reconcileInterest(id)
        } else {
          if (blobs.length)
            watch.push(
              { type: "blobs", sequence: ++this.sequence, blobs },
              blobs.reduce((size, blob) => size + blob.byteLength, 0)
            )
          await marker()
        }
      }
      try {
        for await (const update of updates) {
          if (released) break
          if (update.type === "commit" || update.type === "fragment") {
            if (snapshot) {
              snapshot.push(update.blob)
              update.metadata.free()
              continue
            }
            const record = storedRecord(update)
            watch.push(
              {
                type: "records",
                sequence: ++this.sequence,
                phase: "live",
                records: [record],
              },
              recordBytes(record)
            )
            await marker()
            this.recovering.delete(id)
          } else if (update.type === "storageChecked") {
            if (!snapshot) continue
            if (!initialized && !snapshot.length) {
              const peers = await this.nativeWork(generation, () =>
                engine.getConnectedPeerIds()
              )
              try {
                await deliver(!peers.length)
              } finally {
                peers.forEach(peer => peer.free())
              }
            } else await deliver()
          } else if (update.type === "peerSynced") {
            update.peerId.free()
          } else snapshot = []
        }
      } catch (cause) {
        if (released || this.closed) return
        if (!generation.active) return observe()
        if (initialized && !this.recovering.has(id)) {
          this.recovering.add(id)
          resuming = true
          watch.finish({ type: "rescan-required", sequence: ++this.sequence })
          return
        }
        throw cause
      } finally {
        updates.close()
        native.free()
      }
      if (!released && !this.closed && !generation.active) return observe()
    }
    void observe().catch(cause =>
      watch.finish({
        type: "failure",
        sequence: ++this.sequence,
        error: error("open", cause, true),
      })
    )
    const sessionCheck = (op: BackendOperation) => {
      this.check(op, id)
      if (released) throw new BackendError(op, "closed", "Session is closed")
    }
    return {
      events: watch,
      synchronize: (options = {}) => {
        try {
          sessionCheck("synchronize")
          const work = this.network(id, (engine, generation) =>
            this.syncRound(id, engine, generation, watch)
          )
          void work.catch(cause =>
            watch.push({
              type: "failure",
              sequence: ++this.sequence,
              error: error("synchronize", cause),
            })
          )
          return waitOnly(work, options.signal)
        } catch (cause) {
          return Promise.reject(cause)
        }
      },
      publishEphemeral: async message => {
        sessionCheck("ephemeral")
        let bytes: Uint8Array
        try {
          bytes = encodeEphemeral(message)
        } catch (cause) {
          throw new BackendError(
            "ephemeral",
            "invalid-record",
            String(cause),
            false,
            { cause }
          )
        }
        const generation = this.generation
        const engine = this.engine
        const messageId = message.messageId
        this.checkNetwork(generation, id, "ephemeral")
        await this.nativeWork(generation, async () => {
          const peers = await engine.getConnectedPeerIds()
          try {
            sessionCheck("ephemeral")
            this.checkNetwork(generation, id, "ephemeral")
            if (!peers.length) return
            const native = nativeId(id)
            const topic = N.Topic.fromBytes(native.toBytes())
            native.free()
            try {
              rememberEphemeral(
                this.seenEphemerals,
                `${topicKey(topic.toBytes())}:${messageId}`
              )
              await engine.publishEphemeral(topic, bytes)
            } finally {
              topic.free()
            }
          } finally {
            peers.forEach(peer => peer.free())
          }
        }).catch(cause => {
          throw error("ephemeral", cause)
        })
      },
      markComplete: () => {
        if (!released) this.completed.add(watch)
      },
      close: async () => {
        await watch.return()
      },
    }
  }
  async create(
    initialRecords: RecordBatch,
    options: { documentId?: SedimentreeId } = {}
  ): Promise<SedimentreeId> {
    this.check("create")
    if (!initialRecords.length)
      throw new BackendError(
        "create",
        "invalid-record",
        "Initial history is empty"
      )
    const id = sedimentreeId(
      options.documentId ?? crypto.getRandomValues(new Uint8Array(32))
    )
    await this.storeRecords(id, initialRecords, true)
    return id
  }
  store(input: SedimentreeId, batch: RecordBatch): Promise<void> {
    return this.storeRecords(input, batch)
  }
  private storeRecords(
    input: SedimentreeId,
    batch: RecordBatch,
    creating = false
  ): Promise<void> {
    try {
      const id = sedimentreeId(input)
      this.check("store", id)
      let records: SedimentreeRecord[]
      try {
        records = batch.map(copyRecord)
        if (
          records.some(
            r =>
              r.kind === "fragment" &&
              (r.boundary.length > 255 || r.checkpoints.length > 65535)
          )
        )
          throw new Error("Fragment metadata exceeds native wire count limits")
      } catch (cause) {
        throw new BackendError(
          "store",
          "invalid-record",
          String(cause),
          false,
          { cause }
        )
      }
      const operation = creating ? "create" : "store"
      const run = async (
        engine: N.Subduction,
        generation: EngineGeneration
      ) => {
        const native = nativeId(id)
        let submitted = false
        try {
          if (creating && (await this.bridge.containsSedimentreeId(native)))
            throw new BackendError(
              "create",
              "conflict",
              "Document already exists"
            )
          // Conflict preflight against the batch itself and the stored keys it
          // touches. Native wraps the bridge's own rejection in an opaque error,
          // so detect the typed conflict here first; the bridge check remains
          // authoritative for incoming writes and anything that races past this.
          const conflict = () =>
            new BackendError(
              "store",
              "conflict",
              "Different same-key representation is unsupported"
            )
          // Fragments are exempt: one head can have several valid
          // representations, each stored under its own payload digest.
          const commits = records.filter(
            (r): r is LooseCommitRecord => r.kind === "commit"
          )
          const keys = new Map<string, LooseCommitRecord>()
          for (const record of commits) {
            const old = keys.get(record.id)
            if (old && !equalRecords(old, record)) throw conflict()
            keys.set(record.id, record)
          }
          const stored = await this.bridge.lookupCommits(native, commits)
          for (const [index, record] of commits.entries()) {
            const old = stored[index]
            if (old && !equalRecords(old, record)) throw conflict()
          }
          // One native call: it signs everything, saves through the bridge
          // once and minimizes once. Automerge's own memory limit is reached
          // long before a batch is large enough to need splitting here.
          const inputs: N.CommitInput[] = []
          const fragments: N.FragmentInput[] = []
          try {
            for (const record of records) {
              // Input constructors consume their native payloads.
              if (record.kind === "commit")
                inputs.push(
                  new N.CommitInput(unsigned(native, record), record.blob)
                )
              else
                fragments.push(
                  new N.FragmentInput(
                    unsignedFragment(native, record),
                    record.blob
                  )
                )
            }
            // storeBuiltBatch consumes both kinds of input wrappers.
            submitted = true
            await engine.storeBuiltBatch(native, inputs, fragments)
          } finally {
            if (!submitted) {
              inputs.forEach(c => c.free())
              fragments.forEach(f => f.free())
            }
          }
        } finally {
          // Durability never waits for a peer; a round propagates stores even
          // without a document session. A failed write may still have made
          // some records durable; they must propagate too, and a retry of the
          // whole batch dedupes them.
          if (submitted) this.scheduleSync(id, generation)
          native.free()
        }
      }
      const start = (live: {
        engine: N.Subduction
        generation: EngineGeneration
      }) =>
        this.nativeWork(live.generation, () =>
          run(live.engine, live.generation)
        )
      // Start at once on a live engine so its retirement waits for this store.
      const work = (
        this.generation.active
          ? start({ engine: this.engine, generation: this.generation })
          : this.live(operation, id).then(start)
      ).catch(cause => {
        throw error(operation, cause)
      })
      const attempt = { id, work }
      this.attempts.add(attempt)
      // Successful settled work needs no ledger; failed attempts stay, so every
      // later flush reports them (until the ID is deleted or the backend closes).
      void work.then(
        () => this.attempts.delete(attempt),
        cause => {
          if (
            cause instanceof BackendError &&
            cause.operation === "create" &&
            cause.code === "conflict"
          )
            this.attempts.delete(attempt)
        }
      )
      return work
    } catch (cause) {
      return Promise.reject(cause)
    }
  }
  private async drain(attempts: { work: Promise<void> }[]): Promise<void> {
    const results = await Promise.allSettled(attempts.map(a => a.work))
    const errors = results.flatMap(r =>
      r.status === "rejected" ? [r.reason] : []
    )
    if (errors.length)
      throw new AggregateError(errors, "Accepted persistence attempts failed")
  }
  flush(ids?: readonly SedimentreeId[]): Promise<void> {
    try {
      this.check("flush")
      const filter = ids ? new Set(ids.map(sedimentreeId)) : undefined
      const captured = [...this.attempts].filter(
        a => !filter || filter.has(a.id)
      )
      // Snapshot the filter for the later failure sweep as well.
      const targeted = filter ? [...filter] : undefined
      // Capture native incoming writes now, not after the local-store drain.
      const incoming = this.bridge.flush(targeted)
      return Promise.allSettled([this.drain(captured), incoming]).then(
        async results => {
          // Captured local stores may enter native storage only AFTER flush
          // was called. Report their now-settled bridge failures too, without
          // waiting for subsequently accepted writes.
          results.push(
            ...(await Promise.allSettled([this.bridge.flush(targeted, true)]))
          )
          // Failures are retained, so both bridge passes can see one; and a
          // local store failure usually is its bridge failure. Report once.
          const errors = [
            ...new Set(
              results.flatMap(r =>
                r.status === "rejected"
                  ? r.reason instanceof AggregateError
                    ? r.reason.errors
                    : [r.reason]
                  : []
              )
            ),
          ]
          if (errors.length)
            throw new AggregateError(
              errors,
              "Accepted persistence attempts failed"
            )
        }
      )
    } catch (cause) {
      return Promise.reject(cause)
    }
  }
  deleteLocal(input: SedimentreeId): Promise<void> {
    try {
      const id = sedimentreeId(input)
      this.check("delete")
      if (this.deleting.has(id)) return this.deleting.get(id)!
      this.recovering.delete(id)
      const sequence = ++this.sequence
      for (const [watch, tree] of this.watches)
        if (tree === id) watch.finish({ type: "deleted", sequence })
      // No document-unsubscribe/drain API exists natively. This conservative
      // experiment disconnects ALL peers on deletion, then revokes the entire
      // old engine before removing history. Reconnect explicitly afterward.
      void this.stopNetwork().catch(() => {})
      const run = async () => {
        const native = nativeId(id)
        try {
          await this.resetEngine()
          // Validate the generation before deleting; corrupt storage must not
          // silently appear absent (or be erased as if it had loaded cleanly).
          await this.bridge.records(native)
          await this.engine.removeSedimentree(native)
          await this.bridge.cleanup(native)
          // The history is gone; its earlier write failures no longer apply.
          this.bridge.forget(id)
          for (const attempt of this.attempts)
            if (attempt.id === id) this.attempts.delete(attempt)
        } finally {
          native.free()
          await this.resetEngine()
        }
      }
      const work = this.deleteTail
        .then(run)
        .catch(cause => {
          throw error("delete", cause)
        })
        .finally(() => {
          this.deleting.delete(id)
        })
      this.deleteTail = work.catch(() => {})
      this.deleting.set(id, work)
      return work
    } catch (cause) {
      return Promise.reject(cause)
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    this.recovering.clear()
    this.seenEphemerals.clear()
    const captured = [...this.attempts]
    const deletions = [...this.deleting.values()]
    this.closing = Promise.resolve().then(async () => {
      // A deletion's engine swap must finish before the final retirement.
      await this.deleteTail
      await this.replacing
      const retired = this.retireEngine()
      this.replacing = retired.catch(() => {})
      const outcomes = await Promise.allSettled([
        this.drain(captured),
        ...deletions,
        retired,
      ])
      const incoming = await Promise.allSettled([this.bridge.flush()])
      outcomes.push(...incoming)
      const errors = outcomes.flatMap(r =>
        r.status === "rejected" ? [r.reason] : []
      )
      this.attempts.clear()
      if (errors.length)
        throw new AggregateError(errors, "Backend close failed")
    })
    // Install the close guard before observers or transports can re-enter.
    notifyBackendClosed(this)
    for (const watch of this.watches.keys()) watch.finish()
    // Cancel stalled peer waits immediately, but leave storage enabled until
    // already accepted local operations have finished. Then seal and drain.
    void this.stopNetwork().catch(() => {})
    return this.closing
  }
}
