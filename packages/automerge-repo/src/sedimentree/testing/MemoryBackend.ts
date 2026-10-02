import {
  BackendError,
  type BackendOperation,
  type CollectionObservation,
  type EphemeralEnvelope,
  type SedimentreeBackend,
  type SedimentreeEvent,
  type SedimentreeSession,
  type SyncRoundResult,
} from "../index.js"
import { sedimentreeId, type CommitId, type SedimentreeId } from "../index.js"
import {
  copyRecord,
  equalRecords,
  recordBytes,
  recordHead,
  recordKey,
  type RecordBatch,
  type SedimentreeRecord,
} from "../index.js"
import { Observation, ReplayLog } from "./ReplayLog.js"

export interface MemoryBackendOptions {
  /** Maximum records per delivered batch (a single oversized record is allowed). */
  batchRecords?: number
  /** Target encoded bytes per delivered batch; one record can exceed this. */
  batchBytes?: number
  /** Hard limit on an individual record including metadata. */
  maxRecordBytes?: number
  /** Maximum retained live events per tree/collection. */
  replayEvents?: number
  /** Maximum retained encoded record/metadata bytes in each replay window. */
  replayBytes?: number
}

interface Tree {
  records: Map<string, SedimentreeRecord>
  log: ReplayLog<SedimentreeEvent>
  sessions: Set<MemorySession>
}

/**
 * Deterministic test double, not Repo's default or a production store.
 *
 * Stores exact representations, without compaction or network simulation. Same
 * logical key/different representation rejects; this deliberately does not model
 * Subduction's variant tiebreaking or prove generic history equivalence.
 * Persistence is synchronous and process-local, so flush's barrier is immediate.
 */
export class MemoryBackend implements SedimentreeBackend {
  readonly persistence = "memory" as const
  readonly #options: Required<MemoryBackendOptions>
  readonly #trees = new Map<SedimentreeId, Tree>()
  readonly #collection: ReplayLog<CollectionObservation>
  readonly #collectionWatches = new Set<Observation<CollectionObservation>>()
  #closed = false
  #round = 0

  constructor(options: MemoryBackendOptions = {}) {
    this.#options = {
      batchRecords: options.batchRecords ?? 128,
      batchBytes: options.batchBytes ?? 1024 * 1024,
      maxRecordBytes: options.maxRecordBytes ?? 16 * 1024 * 1024,
      replayEvents: options.replayEvents ?? 128,
      replayBytes: options.replayBytes ?? 4 * 1024 * 1024,
    }
    for (const [name, value] of Object.entries(this.#options)) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(`${name} must be a positive safe integer`)
      }
    }
    this.#collection = this.#log()
  }

  observeCollection(): AsyncIterable<CollectionObservation> {
    this.#assertOpen("observe")
    const ids = [...this.#trees]
      .filter(([, tree]) => tree.records.size > 0)
      .map(([id]) => id)
    const sequence = this.#collection.sequence
    function* initial(): Generator<CollectionObservation> {
      for (const id of ids)
        yield { type: "document", id, phase: "initial", sequence }
      yield { type: "local-load-complete", sequence }
    }
    const watch: Observation<CollectionObservation> =
      new Observation<CollectionObservation>(
        initial(),
        this.#collection,
        event => ({ ...event }),
        sequence => ({ type: "rescan-required", sequence }),
        () => {
          this.#collectionWatches.delete(watch)
        }
      )
    this.#collectionWatches.add(watch)
    return watch
  }

  async create(
    initialRecords: RecordBatch,
    options: { documentId?: SedimentreeId } = {}
  ): Promise<SedimentreeId> {
    this.#assertOpen("create")
    if (!initialRecords.length) {
      throw new BackendError(
        "create",
        "invalid-record",
        "Initial history is empty"
      )
    }
    const id = sedimentreeId(
      options.documentId ?? crypto.getRandomValues(new Uint8Array(32))
    )
    if (this.#trees.get(id)?.records.size)
      throw new BackendError("create", "conflict", "Document already exists")
    await this.store(id, initialRecords)
    return id
  }

  open(rawId: SedimentreeId): SedimentreeSession {
    this.#assertOpen("open")
    const id = sedimentreeId(rawId)
    const tree = this.#tree(id)
    // Immutable private record references pin a finite initial cut without
    // cloning every blob. Blobs are copied only as batches are pulled.
    const snapshot = [...tree.records.values()]
    const heads = headsOf(snapshot)
    const sequence = tree.log.sequence
    const batches = this.#batches(snapshot)
    function* initial(): Generator<SedimentreeEvent> {
      for (const records of batches)
        yield { type: "records", phase: "initial", sequence, records }
      yield {
        type: "local-load-complete",
        checkpoint: { sequence, heads },
        found: snapshot.length > 0,
      }
    }
    const watch = new Observation<SedimentreeEvent>(
      initial(),
      tree.log,
      copyEvent,
      sequence => ({ type: "rescan-required", sequence }),
      () => {
        session.invalidate()
        tree.sessions.delete(session)
        this.#releaseEmpty(id, tree)
      }
    )
    const session = new MemorySession(watch, () => {
      this.#assertOpen("synchronize")
      const roundId = String(++this.#round)
      let result!: SyncRoundResult
      const heads = headsOf([...tree.records.values()])
      tree.log.append(
        sequence => {
          result = {
            roundId,
            checkpoint: { sequence, heads },
            outcome: "no-peers",
            peers: [],
          }
          return { type: "synchronized", result }
        },
        heads.length * 32 + 64
      )
      return copySyncResult(result)
    })
    tree.sessions.add(session)
    return session
  }

  async store(rawId: SedimentreeId, batch: RecordBatch): Promise<void> {
    this.#assertOpen("store")
    const id = sedimentreeId(rawId)
    const staged = new Map<string, SedimentreeRecord>()
    const existing = this.#trees.get(id)
    try {
      // No await before validation/copying: callers may immediately reuse bytes.
      // Staging the batch is convenient for this synchronous double, not an
      // atomicity guarantee: the public contract allows partially persisted batches.
      for (const input of batch) {
        if (recordBytes(input) > this.#options.maxRecordBytes) {
          throw new TypeError("Record exceeds maxRecordBytes")
        }
        const record = copyRecord(input)
        const key = recordKey(record)
        const previous = staged.get(key) ?? existing?.records.get(key)
        if (previous) {
          if (!equalRecords(previous, record)) {
            throw new BackendError(
              "store",
              "conflict",
              `Conflicting representation for ${key}`
            )
          }
        } else staged.set(key, record)
      }
    } catch (error) {
      if (error instanceof BackendError) throw error
      throw new BackendError(
        "store",
        "invalid-record",
        "Invalid sedimentree record",
        false,
        { cause: error }
      )
    }
    if (staged.size === 0) return
    const tree = existing ?? this.#tree(id)
    for (const [key, record] of staged) tree.records.set(key, record)
    for (const records of this.#batches([...staged.values()])) {
      tree.log.append(
        sequence => ({ type: "records", phase: "live", records, sequence }),
        records.reduce((sum, record) => sum + recordBytes(record), 0)
      )
    }
    const heads = headsOf([...tree.records.values()])
    tree.log.append(
      sequence => ({ type: "checkpoint", checkpoint: { sequence, heads } }),
      heads.length * 32 + 32
    )
    this.#collection.append(
      sequence => ({ type: "document", phase: "live", id, sequence }),
      64
    )
  }

  async flush(ids?: readonly SedimentreeId[]): Promise<void> {
    this.#assertOpen("flush")
    ids?.forEach(sedimentreeId)
    // All accepted writes have already settled in this synchronous memory model.
  }

  async deleteLocal(rawId: SedimentreeId): Promise<void> {
    this.#assertOpen("delete")
    const id = sedimentreeId(rawId)
    const tree = this.#trees.get(id)
    if (!tree) return
    this.#trees.delete(id)
    for (const session of [...tree.sessions]) {
      session.end({ type: "deleted", sequence: tree.log.sequence + 1 })
    }
    tree.records.clear()
    tree.log.clear()
    this.#collection.append(sequence => ({ type: "deleted", id, sequence }), 64)
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    for (const watch of [...this.#collectionWatches]) watch.end()
    for (const tree of this.#trees.values()) {
      for (const session of [...tree.sessions]) session.end()
      tree.records.clear()
      tree.log.clear()
    }
    this.#trees.clear()
    this.#collection.clear()
  }

  #assertOpen(operation: BackendOperation): void {
    if (this.#closed)
      throw new BackendError(operation, "closed", "Backend is closed")
  }

  #log<T>(): ReplayLog<T> {
    return new ReplayLog(this.#options.replayEvents, this.#options.replayBytes)
  }

  #tree(id: SedimentreeId): Tree {
    let tree = this.#trees.get(id)
    if (!tree) {
      tree = { records: new Map(), log: this.#log(), sessions: new Set() }
      this.#trees.set(id, tree)
    }
    return tree
  }

  #releaseEmpty(id: SedimentreeId, tree: Tree): void {
    if (
      tree.records.size === 0 &&
      tree.sessions.size === 0 &&
      this.#trees.get(id) === tree
    ) {
      this.#trees.delete(id)
    }
  }

  *#batches(records: readonly SedimentreeRecord[]): Generator<RecordBatch> {
    let batch: SedimentreeRecord[] = []
    let bytes = 0
    for (const record of records) {
      const size = recordBytes(record)
      if (
        batch.length > 0 &&
        (batch.length >= this.#options.batchRecords ||
          bytes + size > this.#options.batchBytes)
      ) {
        yield batch
        batch = []
        bytes = 0
      }
      batch.push(record)
      bytes += size
    }
    if (batch.length) yield batch
  }
}

class MemorySession implements SedimentreeSession {
  #closed = false
  constructor(
    readonly events: Observation<SedimentreeEvent>,
    private synchronizeRound: (() => SyncRoundResult) | undefined
  ) {}

  invalidate(): void {
    this.#closed = true
    this.synchronizeRound = undefined
  }
  end(event?: SedimentreeEvent): void {
    this.events.end(event)
  }

  async synchronize(options?: {
    signal?: AbortSignal
  }): Promise<SyncRoundResult> {
    this.#assertOpen("synchronize")
    options?.signal?.throwIfAborted()
    return this.synchronizeRound!()
  }

  async publishEphemeral(message: EphemeralEnvelope): Promise<void> {
    this.#assertOpen("ephemeral")
    if (
      !message.messageId ||
      !message.origin.id ||
      !message.origin.kind ||
      !(message.payload instanceof Uint8Array)
    ) {
      throw new BackendError(
        "ephemeral",
        "invalid-record",
        "Invalid ephemeral envelope"
      )
    }
    // Best effort with no peers: there is no delivery or retained payload.
  }

  async close(): Promise<void> {
    this.end()
  }

  #assertOpen(operation: BackendOperation): void {
    if (this.#closed)
      throw new BackendError(operation, "closed", "Session is closed")
  }
}

function headsOf(records: readonly SedimentreeRecord[]): CommitId[] {
  const candidates = new Set(records.map(recordHead))
  for (const record of records) {
    if (record.kind === "commit")
      for (const parent of record.parents) candidates.delete(parent)
  }
  // Fragment boundaries cannot prove inclusion in the opaque blob. Retain their
  // targets: the consumer verifies history inclusion, not equality of frontiers.
  return [...candidates].sort()
}

function copySyncResult(result: SyncRoundResult): SyncRoundResult {
  return {
    ...result,
    checkpoint: { ...result.checkpoint, heads: [...result.checkpoint.heads] },
    peers: [],
  }
}

function copyEvent(event: SedimentreeEvent): SedimentreeEvent {
  switch (event.type) {
    case "records":
      return { ...event, records: event.records.map(copyRecord) }
    case "local-load-complete":
    case "checkpoint":
      return {
        ...event,
        checkpoint: { ...event.checkpoint, heads: [...event.checkpoint.heads] },
      }
    case "synchronized":
      return { ...event, result: copySyncResult(event.result) }
    // The memory double never produces peers, remote heads, ephemerals or failures.
    case "remote-heads":
    case "ephemeral":
    case "failure":
      throw new Error(`Unexpected memory observation: ${event.type}`)
    default:
      return { ...event }
  }
}
