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
import { Observation } from "./Observation.js"

export interface MemoryBackendOptions {
  /** Maximum records per delivered batch (a single oversized record is allowed). */
  batchRecords?: number
  /** Target encoded bytes per delivered batch; one record can exceed this. */
  batchBytes?: number
  /** Hard limit on an individual record including metadata. */
  maxRecordBytes?: number
  /**
   * Test seam run inside `store()` after the batch is copied and validated:
   * await to hold the store in flight, throw to fail it. Either way the
   * backend's acknowledgement order and flush see it, unlike a `vi.spyOn` wrapper.
   */
  beforeStore?: (id: SedimentreeId, batch: RecordBatch) => void | Promise<void>
}

interface Tree {
  records: Map<string, SedimentreeRecord>
  sequence: number
  sessions: Set<MemorySession>
}

/**
 * Deterministic test double, not Repo's default or a production store.
 *
 * Stores exact representations, without compaction or network simulation. A
 * different representation of a stored commit rejects. Like Subduction, valid
 * same-head fragment variants coexist (Automerge's fragments depend on arrival
 * order, so two Repos compacting one tree can produce different ones); this
 * does not prove generic history equivalence.
 * Persistence is synchronous and process-local unless `beforeStore` holds a
 * store open. Stores and deletions of one ID are acknowledged in submission
 * order, through the same self-clearing acknowledgement chain the Subduction
 * backend uses; flush reports failures of the work it drained and retains none.
 */
export class MemoryBackend implements SedimentreeBackend {
  readonly #options: Required<Omit<MemoryBackendOptions, "beforeStore">>
  readonly #beforeStore?: MemoryBackendOptions["beforeStore"]
  readonly #trees = new Map<SedimentreeId, Tree>()
  /** The latest store or deletion per ID; flush and delete wait on it. */
  readonly #acks = new Map<SedimentreeId, Promise<void>>()
  /** Deletion barriers: open, create and store reject until removal settles. */
  readonly #deleting = new Map<SedimentreeId, Promise<void>>()
  #closed = false
  #round = 0

  constructor(options: MemoryBackendOptions = {}) {
    this.#beforeStore = options.beforeStore
    this.#options = {
      batchRecords: options.batchRecords ?? 128,
      batchBytes: options.batchBytes ?? 1024 * 1024,
      maxRecordBytes: options.maxRecordBytes ?? 16 * 1024 * 1024,
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
    this.#assertNotDeleting("create", id)
    if (this.#trees.get(id)?.records.size)
      throw new BackendError("create", "conflict", "Document already exists")
    await this.store(id, initialRecords)
    return id
  }

  open(rawId: SedimentreeId): SedimentreeSession {
    this.#assertOpen("open")
    const id = sedimentreeId(rawId)
    this.#assertNotDeleting("open", id)
    const tree = this.#tree(id)
    // Immutable private record references pin a finite initial cut without
    // cloning every blob. Blobs are copied only as batches are pulled.
    const snapshot = [...tree.records.values()]
    const heads = headsOf(snapshot)
    const sequence = tree.sequence
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
      copyEvent,
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
      this.#append(tree, sequence => {
        result = {
          roundId,
          marker: { sequence, heads },
          outcome: "no-peers",
          peers: [],
        }
        return { type: "synchronized", result }
      })
      return copySyncResult(result)
    })
    tree.sessions.add(session)
    return session
  }

  store(rawId: SedimentreeId, batch: RecordBatch): Promise<void> {
    let id: SedimentreeId
    try {
      this.#assertOpen("store")
      id = sedimentreeId(rawId)
      this.#assertNotDeleting("store", id)
    } catch (error) {
      return Promise.reject(error)
    }
    const write = this.#store(id, batch)
    const earlier = this.#acks.get(id)
    const ack = earlier
      ? Promise.allSettled([earlier, write]).then(([before, own]) => {
          if (own.status === "rejected") throw own.reason
          if (before.status === "rejected")
            throw new BackendError(
              "store",
              "io",
              "An earlier store to this document failed",
              false,
              { cause: before.reason }
            )
        })
      : write
    this.#acks.set(id, ack)
    const clear = () => {
      if (this.#acks.get(id) === ack) this.#acks.delete(id)
    }
    void ack.then(clear, clear)
    return ack
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
        // Fragments: one key per representation (like native's digest keys),
        // so same-head variants coexist. Commits: one representation per ID.
        let key = recordKey(record)
        if (record.kind === "fragment") {
          for (let variant = 0; ; variant++) {
            key = `${recordKey(record)}#${variant}`
            const held = staged.get(key) ?? existing?.records.get(key)
            if (!held || equalRecords(held, record)) break
          }
        }
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
      throw cause instanceof BackendError
        ? cause
        : new BackendError(
            "store",
            "invalid-record",
            "Invalid sedimentree record",
            false,
            { cause }
          )
    }
    if (this.#beforeStore) await this.#beforeStore(id, [...staged.values()])
    if (staged.size === 0) return
    const tree = this.#trees.get(id) ?? this.#tree(id)
    for (const [key, record] of staged) tree.records.set(key, record)
    for (const records of this.#batches([...staged.values()])) {
      this.#append(tree, sequence => ({
        type: "records",
        phase: "live",
        records,
        sequence,
      }))
    }
    const heads = headsOf([...tree.records.values()])
    this.#append(tree, sequence => ({
      type: "history-marker",
      marker: { sequence, heads },
    }))
  }

  async flush(ids?: readonly SedimentreeId[]): Promise<void> {
    this.#assertOpen("flush")
    const targets = ids?.map(sedimentreeId)
    // Capture the barrier now; stores accepted later are not part of it.
    const captured = targets
      ? targets.flatMap(id => this.#acks.get(id) ?? [])
      : [...this.#acks.values()]
    const errors = (await Promise.allSettled(captured)).flatMap(result =>
      result.status === "rejected" ? [result.reason] : []
    )
    if (errors.length)
      throw new AggregateError(errors, "Accepted persistence attempts failed")
  }

  deleteLocal(rawId: SedimentreeId): Promise<void> {
    let id: SedimentreeId
    try {
      this.#assertOpen("delete")
      id = sedimentreeId(rawId)
    } catch (error) {
      return Promise.reject(error)
    }
    const pending = this.#deleting.get(id)
    if (pending) return pending
    // Joins the acknowledgement chain: earlier stores land first, and flush
    // covers the removal. The barrier keeps later work off the chain.
    const earlier = this.#acks.get(id)
    const removal = (async () => {
      await Promise.allSettled([earlier])
      const tree = this.#trees.get(id)
      if (!tree) return
      this.#trees.delete(id)
      for (const session of [...tree.sessions]) {
        session.end({ type: "deleted", sequence: tree.sequence + 1 })
      }
      tree.records.clear()
    })().finally(() => {
      if (this.#acks.get(id) === removal) this.#acks.delete(id)
      this.#deleting.delete(id)
    })
    this.#acks.set(id, removal)
    this.#deleting.set(id, removal)
    return removal
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    for (const tree of this.#trees.values()) {
      for (const session of [...tree.sessions]) session.end()
      tree.records.clear()
    }
    this.#trees.clear()
  }

  #assertOpen(operation: BackendOperation): void {
    if (this.#closed)
      throw new BackendError(operation, "closed", "Backend is closed")
  }

  #assertNotDeleting(operation: BackendOperation, id: SedimentreeId): void {
    if (this.#deleting.has(id))
      throw new BackendError(operation, "deleted", "Deletion barrier is active")
  }

  #append(tree: Tree, make: (sequence: number) => SedimentreeEvent): void {
    const event = make(++tree.sequence)
    for (const session of tree.sessions) session.events.push(event)
  }

  #tree(id: SedimentreeId): Tree {
    let tree = this.#trees.get(id)
    if (!tree) {
      tree = { records: new Map(), sequence: 0, sessions: new Set() }
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
