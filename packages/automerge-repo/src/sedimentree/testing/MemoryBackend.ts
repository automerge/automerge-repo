import {
  BackendError,
  type BackendOperation,
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
  /** Maximum retained live events per tree. */
  replayEvents?: number
  /** Maximum retained encoded record/metadata bytes in each replay window. */
  replayBytes?: number
  /**
   * Test seam run inside `store()` after the batch is copied and validated:
   * await to hold the store in flight, throw to fail it. Either way the
   * backend's barrier and failure memory see it, unlike a `vi.spyOn` wrapper.
   */
  beforeStore?: (id: SedimentreeId, batch: RecordBatch) => void | Promise<void>
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
 * Persistence is synchronous and process-local, so flush's barrier is immediate
 * and stores to one ID are acknowledged in submission order; flush reports
 * rejected stores until the ID is deleted.
 */
export class MemoryBackend implements SedimentreeBackend {
  readonly #options: Required<Omit<MemoryBackendOptions, "beforeStore">>
  readonly #beforeStore?: MemoryBackendOptions["beforeStore"]
  readonly #trees = new Map<SedimentreeId, Tree>()
  /** Stores held open by `beforeStore`; flush and delete drain them. */
  readonly #inFlight = new Set<Promise<void>>()
  /** Rejected stores, reported by every later flush until the ID is deleted. */
  readonly #failed = new Map<SedimentreeId, unknown[]>()
  #closed = false
  #round = 0

  constructor(options: MemoryBackendOptions = {}) {
    this.#beforeStore = options.beforeStore
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
        marker: { sequence, heads },
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
            marker: { sequence, heads },
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
    const work = this.#store(sedimentreeId(rawId), batch)
    this.#inFlight.add(work)
    try {
      await work
    } finally {
      this.#inFlight.delete(work)
    }
  }

  async #store(id: SedimentreeId, batch: RecordBatch): Promise<void> {
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
    } catch (cause) {
      throw this.#fail(
        id,
        cause instanceof BackendError
          ? cause
          : new BackendError(
              "store",
              "invalid-record",
              "Invalid sedimentree record",
              false,
              { cause }
            )
      )
    }
    if (this.#beforeStore) {
      try {
        await this.#beforeStore(id, [...staged.values()])
      } catch (error) {
        throw this.#fail(id, error)
      }
    }
    if (staged.size === 0) return
    const tree = this.#trees.get(id) ?? this.#tree(id)
    for (const [key, record] of staged) tree.records.set(key, record)
    for (const records of this.#batches([...staged.values()])) {
      tree.log.append(
        sequence => ({ type: "records", phase: "live", records, sequence }),
        records.reduce((sum, record) => sum + recordBytes(record), 0)
      )
    }
    const heads = headsOf([...tree.records.values()])
    tree.log.append(
      sequence => ({ type: "history-marker", marker: { sequence, heads } }),
      heads.length * 32 + 32
    )
  }

  async flush(ids?: readonly SedimentreeId[]): Promise<void> {
    this.#assertOpen("flush")
    const targets = ids?.map(sedimentreeId)
    // Capture the barrier now; stores accepted later are not part of it.
    await this.#drain()
    const errors = (targets ?? [...this.#failed.keys()]).flatMap(
      id => this.#failed.get(id) ?? []
    )
    if (errors.length)
      throw new AggregateError(errors, "Accepted persistence attempts failed")
  }

  async deleteLocal(rawId: SedimentreeId): Promise<void> {
    this.#assertOpen("delete")
    const id = sedimentreeId(rawId)
    await this.#drain()
    this.#failed.delete(id)
    const tree = this.#trees.get(id)
    if (!tree) return
    this.#trees.delete(id)
    for (const session of [...tree.sessions]) {
      session.end({ type: "deleted", sequence: tree.log.sequence + 1 })
    }
    tree.records.clear()
    tree.log.clear()
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    for (const tree of this.#trees.values()) {
      for (const session of [...tree.sessions]) session.end()
      tree.records.clear()
      tree.log.clear()
    }
    this.#trees.clear()
  }

  #drain(): Promise<unknown> {
    return Promise.allSettled([...this.#inFlight])
  }

  #fail(id: SedimentreeId, error: unknown): unknown {
    this.#failed.set(id, [...(this.#failed.get(id) ?? []), error])
    return error
  }

  #assertOpen(operation: BackendOperation): void {
    if (this.#closed)
      throw new BackendError(operation, "closed", "Backend is closed")
  }

  #log(): ReplayLog<SedimentreeEvent> {
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
    marker: { ...result.marker, heads: [...result.marker.heads] },
    peers: [],
  }
}

function copyEvent(event: SedimentreeEvent): SedimentreeEvent {
  switch (event.type) {
    case "records":
      return { ...event, records: event.records.map(copyRecord) }
    case "blobs":
      return {
        ...event,
        blobs: event.blobs.map(blob => new Uint8Array(blob)),
      }
    case "local-load-complete":
    case "history-marker":
      return event.marker
        ? {
            ...event,
            marker: { ...event.marker, heads: [...event.marker.heads] },
          }
        : { ...event }
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
