import * as N from "@automerge/subduction/slim"
import {
  BackendError,
  commitId,
  copyRecord,
  equalRecords,
  recordBytes,
  recordHead,
  recordKey,
  sedimentreeId,
  type BackendIdentity,
  type BackendOperation,
  type CollectionObservation,
  type CommitId,
  type HistoryCheckpoint,
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
  unsigned,
  unsignedFragment,
  type LocalByteStore,
} from "./storage.js"
import { Watch } from "./watch.js"
import { notifyBackendClosed } from "./backendLifecycle.js"
import {
  copyEphemeral,
  decodeEphemeral,
  encodeEphemeral,
  rememberEphemeral,
  topicKey,
} from "./ephemeral.js"

export type { LocalByteStore } from "./storage.js"
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
  active: boolean
  stopping?: Promise<void>
  work: Set<Promise<unknown>>
  repairScheduled?: boolean
  controlTail: Promise<unknown>
  interests: Set<SedimentreeId>
}

export interface SubductionBackendOptions {
  signer: NativeSigner
  storage: LocalByteStore
  /** Native request deadline, not a deadline on local storage or handshake. */
  syncTimeoutMilliseconds?: number
  /** Largest single record (signed metadata plus blob). */
  maxRecordBytes?: number
  /** Largest single store()/create() submission; records and bytes. */
  maxBatchBytes?: number
  batchRecords?: number
  /** Initial-delivery batch target per `records` event. */
  batchBytes?: number
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
/** Conservative heads of delivered history, maintained incrementally. */
class Heads {
  private readonly heads = new Set<CommitId>()
  private readonly parents = new Set<CommitId>()
  add(record: SedimentreeRecord): void {
    // Loose-commit dependencies are validated by the translator. Fragment
    // boundaries/checkpoint prefixes are not authenticated by a standalone blob:
    // they cannot justify dropping another delivered head's readiness target.
    // Extra historical heads are safe because readiness checks history inclusion.
    if (record.kind === "commit")
      for (const parent of record.parents) {
        this.parents.add(parent)
        this.heads.delete(parent)
      }
    const head = recordHead(record)
    if (!this.parents.has(head)) this.heads.add(head)
  }
  checkpoint(sequence: number): HistoryCheckpoint {
    return { sequence, heads: [...this.heads].sort() }
  }
}
function checkpoint(
  sequence: number,
  records: readonly SedimentreeRecord[]
): HistoryCheckpoint {
  const heads = new Heads()
  for (const record of records) heads.add(record)
  return heads.checkpoint(sequence)
}
function copyEvent(value: SedimentreeEvent): SedimentreeEvent {
  if (value.type === "ephemeral")
    return {
      ...value,
      message: copyEphemeral(value.message),
      sender: { ...value.sender, path: [...value.sender.path] },
    }
  if (value.type === "records")
    return { ...value, records: value.records.map(copyRecord) }
  if (value.type === "checkpoint" || value.type === "local-load-complete")
    return {
      ...value,
      checkpoint: { ...value.checkpoint, heads: [...value.checkpoint.heads] },
    }
  if (value.type === "synchronized")
    return {
      ...value,
      result: {
        ...value.result,
        checkpoint: {
          ...value.result.checkpoint,
          heads: [...value.result.checkpoint.heads],
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
  private networkTail: Promise<unknown> = Promise.resolve()
  private networkEnabled = false
  private readonly pendingSyncs = new Set<SedimentreeId>()
  private readonly scheduled = new Map<
    SedimentreeId,
    { generation: EngineGeneration; again: boolean }
  >()
  private readonly checkpoints = new Set<SedimentreeId>()
  private tail: Promise<unknown> = Promise.resolve()
  private closed = false
  private closing?: Promise<void>
  private sequence = 0
  private round = 0
  private readonly deleting = new Map<SedimentreeId, Promise<void>>()
  private readonly watches = new Map<Watch<SedimentreeEvent>, SedimentreeId>()
  /** Sessions whose consumer verified a complete snapshot (markComplete). */
  private readonly completed = new Set<Watch<SedimentreeEvent>>()
  /** Heads of history delivered per open tree; replaces storage rescans for
   * checkpoints once every session on the tree is complete. */
  private readonly delivered = new Map<SedimentreeId, Heads>()
  private readonly collections = new Set<Watch<CollectionObservation>>()
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
      maxRecordBytes: options.maxRecordBytes ?? 16 * 1024 * 1024,
      maxBatchBytes: options.maxBatchBytes ?? 64 * 1024 * 1024,
      batchRecords: options.batchRecords ?? 128,
      batchBytes: options.batchBytes ?? 1024 * 1024,
      replayEvents: options.replayEvents ?? 128,
      replayBytes: options.replayBytes ?? 4 * 1024 * 1024,
    }
    for (const value of Object.values(this.limits))
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new TypeError("Limits must be positive safe integers")
    if (this.limits.syncTimeoutMilliseconds > 0xffffffff)
      throw new TypeError("Sync timeout exceeds native u32 range")
    this.bridge = new StorageBridge(
      options.storage,
      this.limits,
      (id, record) => this.persisted(id, record),
      id => this.storageFailed(id)
    )
    this.engine = this.createEngine()
  }
  private createEngine(): N.Subduction {
    const generation: EngineGeneration = {
      active: true,
      work: new Set(),
      controlTail: Promise.resolve(),
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
          if (!generation.active)
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
    await this.bridge.drain()
    this.engine.free()
    // Failed syncs are reported to their callers/streams, not as close errors.
    if (stopped[0].status === "rejected") throw stopped[0].reason
  }
  private async resetEngine(): Promise<void> {
    try {
      await this.retireEngine()
    } finally {
      this.engine = this.createEngine()
      for (const id of new Set(this.watches.values()))
        this.reconcileInterest(id)
    }
  }
  private storageFailed(id: SedimentreeId): void {
    this.requireRescan(id)
    const generation = this.generation
    if (this.closed || generation.repairScheduled) return
    generation.repairScheduled = true
    // Never await the owner queue from a native storage callback: a local
    // operation may itself be waiting for this exact callback to return.
    void this.enqueue("store", async () => {
      if (generation === this.generation) await this.resetEngine()
    }).catch(() => this.requireRescan(id))
  }

  /** Borrow the authenticated wrapper until this promise settles. On success,
   * the engine owns a connection clone and disconnects it on close/reset/delete.
   * Keep the underlying JS transport alive until disconnection. Authentication
   * is the caller's responsibility; no document handle is materialized here.
   */
  addConnection(transport: AuthenticatedTransport): Promise<boolean> {
    try {
      this.check("synchronize")
      return this.enqueue("synchronize", async () => {
        this.check("synchronize")
        // Do fallible inventory I/O before installation: a rejected onboarding
        // must not leave a live connection whose ownership was never accepted.
        const ids = new Set(this.watches.values())
        await this.bridge.inventory(stored => stored.forEach(id => ids.add(id)))
        this.check("synchronize")
        return { ids, engine: this.engine, generation: this.generation }
      })
        .then(({ ids, engine, generation }) => {
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
            this.networkEnabled = true
            // Inventory predates native onboarding; retain interests accepted
            // while its replay was waiting outside the persistence queue.
            for (const id of this.pendingSyncs) ids.add(id)
            this.pendingSyncs.clear()
            // Replay open interests AND stored, unopened documents on reconnect.
            for (const id of ids) this.scheduleSync(id)
            return added
          })
        })
        .catch(cause => {
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
    const work = generation.controlTail.then(() => {
      if (!generation.active || generation.stopping || this.closed) return
      const desired =
        !this.deleting.has(id) &&
        [...this.watches].some(([watch, tree]) => tree === id && watch.active)
      if (desired === generation.interests.has(id)) return
      return this.nativeWork(generation, async () => {
        const native = nativeId(id)
        const topic = N.Topic.fromBytes(native.toBytes())
        native.free()
        try {
          // Native may update its local interest before a control send fails.
          // Record the attempted state so a released observer still cleans up.
          if (desired) generation.interests.add(id)
          else generation.interests.delete(id)
          if (desired) await engine.subscribeEphemeral([topic])
          else await engine.unsubscribeEphemeral([topic])
        } finally {
          topic.free()
        }
      })
    })
    generation.controlTail = work.catch(cause => {
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
    run: (engine: N.Subduction, generation: EngineGeneration) => Promise<T>
  ): Promise<T> {
    const prior = this.tail
    const generation = this.generation
    const engine = this.engine
    const work = this.networkTail.then(async () => {
      // Waiting for the owner queue is NOT native work: retirement runs on
      // that queue and must not wait on itself through a scheduled round.
      await prior
      this.checkNetwork(generation)
      const running = run(engine, generation)
      generation.work.add(running)
      try {
        return await running
      } finally {
        generation.work.delete(running)
      }
    })
    this.networkTail = work.catch(() => {})
    return work
  }
  private scheduleSync(id: SedimentreeId): void {
    if (this.closed || this.deleting.has(id) || this.generation.stopping) return
    if (!this.networkEnabled) {
      this.pendingSyncs.add(id)
      return
    }
    const old = this.scheduled.get(id)
    if (old?.generation === this.generation) {
      old.again = true
      return
    }
    const job = { generation: this.generation, again: false }
    this.scheduled.set(id, job)
    void this.network((engine, generation) =>
      this.syncRound(id, engine, generation)
    )
      .catch(cause => {
        if (!this.closed && job.generation.active && !this.deleting.has(id))
          for (const [watch, tree] of this.watches)
            if (tree === id)
              watch.push({
                type: "failure",
                sequence: ++this.sequence,
                error: error("synchronize", cause),
              })
      })
      .finally(() => {
        if (this.scheduled.get(id) !== job) return
        this.scheduled.delete(id)
        if (job.again && job.generation === this.generation)
          this.scheduleSync(id)
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
      const outcomes: SyncRoundResult["peers"][number][] = []
      let remoteHasHeads = false
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
            if (response.success) {
              const stats = response.stats
              const heads = stats.remoteHeads
              try {
                remoteHasHeads ||= heads.length > 0
              } finally {
                heads.forEach(head => head.free())
                stats.free()
              }
            }
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
      const publish = (checkpoint: HistoryCheckpoint) => {
        result = {
          roundId,
          checkpoint,
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
                64 + result.checkpoint.heads.length * 32 + outcomes.length * 128
              )
      }
      const delivered = this.delivered.get(id)
      if (delivered && this.settled(id)) {
        // Every session already verified readiness: order behind the records
        // this round ingested without rereading the whole tree from storage.
        await this.bridge.drain()
        publish(delivered.checkpoint(++this.sequence))
      } else {
        await this.bridge.records(native, records =>
          publish(checkpoint(++this.sequence, records))
        )
      }
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
  /** Reserving the promise chain happens synchronously, before any await. */
  private enqueue<T>(
    operation: BackendOperation,
    run: () => Promise<T>
  ): Promise<T> {
    const work = this.tail.then(run).catch(cause => {
      throw error(operation, cause)
    })
    this.tail = work.catch(() => {})
    return work
  }
  /** True when no open session on this tree still needs storage checkpoints. */
  private settled(id: SedimentreeId): boolean {
    for (const [watch, tree] of this.watches)
      if (tree === id && !this.completed.has(watch)) return false
    return true
  }
  private persisted(id: SedimentreeId, record: SedimentreeRecord): void {
    if (this.closed || this.deleting.has(id)) return
    const sequence = ++this.sequence
    this.delivered.get(id)?.add(record)
    for (const [watch, tree] of this.watches)
      if (tree === id)
        watch.push(
          { type: "records", sequence, phase: "live", records: [record] },
          recordBytes(record)
        )
    for (const watch of this.collections)
      watch.push({ type: "document", sequence, phase: "live", id })
    // Checkpoints only establish readiness. Once every session on this tree
    // has verified its snapshot, the authoritative storage cut is not needed.
    if (this.settled(id)) return
    // This applies equally to local writes and unsolicited native ingestion.
    // Queue the cut behind the current complete bridge transaction, coalescing
    // batches. Never use onRemoteHeads (which precedes ingest) as completeness.
    if (!this.checkpoints.has(id)) {
      this.checkpoints.add(id)
      const native = nativeId(id)
      void this.bridge
        .records(native, records => {
          this.checkpoints.delete(id)
          if (this.closed || this.deleting.has(id)) return
          const target = checkpoint(++this.sequence, records)
          for (const [watch, tree] of this.watches)
            if (tree === id)
              watch.push(
                { type: "checkpoint", checkpoint: target },
                32 + target.heads.length * 32
              )
        })
        .catch(() => {
          this.checkpoints.delete(id)
          this.requireRescan(id)
        })
        .finally(() => native.free())
    }
  }
  private requireRescan(id: SedimentreeId): void {
    if (this.closed) return
    const sequence = ++this.sequence
    // save() can commit a value and still reject (e.g. an ambiguous I/O result).
    // Its notification was then missed. Never let deduplicating a retry hide
    // that record: active observations must reconcile authoritative storage.
    // Not-yet-initialized watches have later queued cuts and recover it there.
    for (const [watch, tree] of this.watches)
      if (tree === id && watch.active)
        watch.finish({ type: "rescan-required", sequence })
    for (const watch of this.collections)
      if (watch.active) watch.finish({ type: "rescan-required", sequence })
  }
  private async snapshot(
    id: SedimentreeId,
    consume?: (records: SedimentreeRecord[]) => void
  ): Promise<SedimentreeRecord[]> {
    const native = nativeId(id)
    try {
      // This forces actual native hydration/validation on a fresh backend. Its
      // minimized metadata is deliberately NOT zipped with any blob enumeration.
      const commits = await this.engine.getCommits(native)
      commits?.forEach(c => c.free())
      const fragments = await this.engine.getFragments(native)
      fragments?.forEach(f => f.free())
      // Install the cut inside the serialized read, before another save can
      // notify. Hydration must precede this cut, not leave a gap after it.
      return await this.bridge.records(native, consume)
    } finally {
      native.free()
    }
  }
  private batches(
    records: readonly SedimentreeRecord[],
    sequence: number
  ): SedimentreeEvent[] {
    const events: SedimentreeEvent[] = []
    let batch: SedimentreeRecord[] = [],
      size = 0
    const emit = () => {
      if (batch.length)
        events.push({
          type: "records",
          sequence,
          phase: "initial",
          records: batch,
        })
      batch = []
      size = 0
    }
    for (const record of records) {
      const bytes = recordBytes(record)
      if (
        batch.length &&
        (batch.length >= this.limits.batchRecords ||
          size + bytes > this.limits.batchBytes)
      )
        emit()
      batch.push(record)
      size += bytes
    }
    emit()
    return events
  }
  open(input: SedimentreeId): SedimentreeSession {
    const id = sedimentreeId(input)
    this.check("open", id)
    let released = false
    const watch = new Watch<SedimentreeEvent>(
      this.limits.replayEvents,
      this.limits.replayBytes,
      copyEvent,
      () => ({ type: "rescan-required", sequence: ++this.sequence }),
      () => {
        released = true
        this.watches.delete(watch)
        this.completed.delete(watch)
        if (![...this.watches.values()].includes(id)) this.delivered.delete(id)
        this.reconcileInterest(id)
      }
    )
    this.watches.set(watch, id)
    void this.enqueue("open", async () => {
      await this.snapshot(id, records => {
        const sequence = ++this.sequence
        // The cut is installed inside the serialized read, so delivered heads
        // seeded here stay ahead of any later persisted() notification.
        const heads = new Heads()
        for (const record of records) heads.add(record)
        if (!released) this.delivered.set(id, heads)
        watch.initialize([
          ...this.batches(records, sequence),
          {
            type: "local-load-complete",
            checkpoint: heads.checkpoint(sequence),
            found: records.length > 0,
          },
        ])
      })
      if (!released) {
        this.reconcileInterest(id)
        this.scheduleSync(id)
      }
    }).catch(cause =>
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
          const work = this.network((engine, generation) =>
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
        await this.tail
        sessionCheck("ephemeral")
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
  observeCollection(): AsyncIterable<CollectionObservation> {
    this.check("observe")
    const watch = new Watch<CollectionObservation>(
      this.limits.replayEvents,
      this.limits.replayBytes,
      value => ({ ...value }),
      () => ({ type: "rescan-required", sequence: ++this.sequence }),
      () => {
        this.collections.delete(watch)
      }
    )
    this.collections.add(watch)
    void this.enqueue("observe", async () => {
      await this.bridge.inventory(ids => {
        const sequence = ++this.sequence
        watch.initialize([
          ...ids.map(id => ({
            type: "document" as const,
            sequence,
            phase: "initial" as const,
            id,
          })),
          { type: "local-load-complete", sequence },
        ])
      })
    }).catch(cause =>
      watch.finish({
        type: "failure",
        sequence: ++this.sequence,
        error: error("observe", cause, true),
      })
    )
    return watch
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
        if (
          records.length > this.limits.batchRecords ||
          records.reduce((n, r) => n + recordBytes(r), 0) >
            this.limits.maxBatchBytes ||
          records.some(r => recordBytes(r) + 512 > this.limits.maxRecordBytes)
        )
          throw new Error("Store batch/record limit exceeded")
      } catch (cause) {
        throw new BackendError(
          "store",
          "invalid-record",
          String(cause),
          false,
          { cause }
        )
      }
      const work = this.enqueue(creating ? "create" : "store", async () => {
        const native = nativeId(id)
        const inputs: N.CommitInput[] = []
        const fragments: N.FragmentInput[] = []
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
          const keys = new Map<string, SedimentreeRecord>()
          for (const record of records) {
            const old = keys.get(recordKey(record))
            if (old && !equalRecords(old, record)) throw conflict()
            keys.set(recordKey(record), record)
          }
          const stored = await this.bridge.lookup(native, records)
          for (const [index, record] of records.entries()) {
            const old = stored[index]
            if (old && !equalRecords(old, record)) throw conflict()
          }
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
          if (inputs.length || fragments.length) {
            // storeBuiltBatch consumes both kinds of input wrappers.
            submitted = true
            await this.engine.storeBuiltBatch(native, inputs, fragments)
          }
          // Native awaits the storage bridge for every record before touching
          // its in-memory tree, and minimization never deletes from storage, so
          // a resolved storeBuiltBatch means every submitted record is saved.
          // Durability never waits for a peer. A separate coalesced network
          // queue propagates stores even without a document session.
          if (records.length) this.scheduleSync(id)
        } catch (cause) {
          // A rejected create has not submitted anything and needs no recovery.
          if (
            !(
              cause instanceof BackendError &&
              cause.operation === "create" &&
              cause.code === "conflict"
            )
          ) {
            this.requireRescan(id)
            await this.resetEngine()
          }
          throw cause
        } finally {
          if (!submitted) {
            inputs.forEach(c => c.free())
            fragments.forEach(f => f.free())
          }
          native.free()
        }
      })
      const attempt = { id, work }
      this.attempts.add(attempt)
      // Successful settled work needs no ledger; failed attempts remain visible
      // until a captured flush/close barrier has reported them.
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
      return Promise.allSettled([this.drain(captured), incoming])
        .then(async results => {
          // Captured local stores may enter native storage only AFTER flush
          // was called. Report/retire their now-settled bridge failures too,
          // without waiting for subsequently accepted writes.
          results.push(
            ...(await Promise.allSettled([this.bridge.flush(targeted, true)]))
          )
          const errors = results.flatMap(r =>
            r.status === "rejected" ? [r.reason] : []
          )
          if (errors.length)
            throw new AggregateError(
              errors,
              "Accepted persistence attempts failed"
            )
        })
        .finally(() => captured.forEach(a => this.attempts.delete(a)))
    } catch (cause) {
      return Promise.reject(cause)
    }
  }
  deleteLocal(input: SedimentreeId): Promise<void> {
    try {
      const id = sedimentreeId(input)
      this.check("delete")
      if (this.deleting.has(id)) return this.deleting.get(id)!
      this.pendingSyncs.delete(id)
      const sequence = ++this.sequence
      for (const [watch, tree] of this.watches)
        if (tree === id) watch.finish({ type: "deleted", sequence })
      // No document-unsubscribe/drain API exists natively. This conservative
      // experiment disconnects ALL peers on deletion, then revokes the entire
      // old engine before removing history. Reconnect explicitly afterward.
      void this.stopNetwork().catch(() => {})
      const work = this.enqueue("delete", async () => {
        const native = nativeId(id)
        try {
          await this.resetEngine()
          // Validate the generation before deleting; corrupt storage must not
          // silently appear absent (or be erased as if it had loaded cleanly).
          await this.bridge.records(native)
          await this.engine.removeSedimentree(native)
          await this.bridge.cleanup(native)
          if (!this.closed)
            for (const watch of this.collections)
              watch.push({ type: "deleted", sequence: ++this.sequence, id })
        } catch (cause) {
          // Removal can partly succeed (or commit then reject). Existing
          // collection inventories must reconcile even without a success event.
          this.requireRescan(id)
          throw cause
        } finally {
          native.free()
          await this.resetEngine()
        }
      }).finally(() => {
        this.deleting.delete(id)
      })
      this.deleting.set(id, work)
      return work
    } catch (cause) {
      return Promise.reject(cause)
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    this.pendingSyncs.clear()
    this.seenEphemerals.clear()
    const captured = [...this.attempts]
    const deletions = [...this.deleting.values()]
    this.closing = Promise.resolve().then(async () => {
      await this.tail
      const retired = this.retireEngine()
      const outcomes = await Promise.allSettled([
        this.drain(captured),
        ...deletions,
        retired,
      ])
      await this.networkTail
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
    for (const watch of this.collections) watch.finish()
    // Cancel stalled peer waits immediately, but leave storage enabled until
    // already accepted local operations have finished. Then seal and drain.
    void this.stopNetwork().catch(() => {})
    return this.closing
  }
}
