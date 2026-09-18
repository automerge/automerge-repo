import * as N from "@automerge/subduction/slim"
import {
  BackendError,
  copyRecord,
  equalRecords,
  recordBytes,
  sedimentreeId,
  type BackendOperation,
  type CollectionObservation,
  type HistoryCheckpoint,
  type LooseCommitRecord,
  type RecordBatch,
  type SedimentreeBackend,
  type SedimentreeEvent,
  type SedimentreeId,
  type SedimentreeSession,
  type SyncRoundResult,
} from "@automerge/automerge-repo-sedimentree"
import {
  StorageBridge,
  nativeId,
  logicalId,
  unsigned,
  type LocalByteStore,
} from "./storage.js"
import { Watch } from "./watch.js"

export type { LocalByteStore } from "./storage.js"
/** Borrowed interface: the caller keeps the signer alive through backend.close(). */
export type NativeSigner = N.Signer
export interface SubductionBackendOptions {
  signer: NativeSigner
  storage: LocalByteStore
  /** Explicit declaration of the injected store's recoverability (not fsync). */
  persistence: "memory" | "persistent"
  maxRecordBytes?: number
  maxSnapshotBytes?: number
  maxRecords?: number
  batchRecords?: number
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
function checkpoint(
  sequence: number,
  records: readonly LooseCommitRecord[]
): HistoryCheckpoint {
  const heads = new Set(records.map(r => r.id))
  records.forEach(r => r.parents.forEach(p => heads.delete(p)))
  return { sequence, heads: [...heads].sort((a, b) => a.localeCompare(b)) }
}
function copyEvent(value: SedimentreeEvent): SedimentreeEvent {
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
        peers: [],
      },
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

/** EXPERIMENTAL: real WASM persistence, local-only, commit-only, exclusive owner.
 * Initialize Subduction WASM before construction. No transports are exposed.
 */
export class SubductionBackend implements SedimentreeBackend {
  readonly persistence: "memory" | "persistent"
  private readonly limits: Required<
    Omit<SubductionBackendOptions, "signer" | "storage" | "persistence">
  >
  private readonly bridge: StorageBridge
  private engine: N.Subduction
  private tail: Promise<unknown> = Promise.resolve()
  private closed = false
  private closing?: Promise<void>
  private sequence = 0
  private round = 0
  private readonly deleting = new Map<SedimentreeId, Promise<void>>()
  private readonly watches = new Map<Watch<SedimentreeEvent>, SedimentreeId>()
  private readonly collections = new Set<Watch<CollectionObservation>>()
  private readonly attempts = new Set<{
    id: SedimentreeId
    work: Promise<void>
  }>()

  private readonly signer: NativeSigner

  constructor(options: SubductionBackendOptions) {
    this.signer = options.signer
    if (
      options.persistence !== "memory" &&
      options.persistence !== "persistent"
    )
      throw new TypeError("Declare the byte store's persistence explicitly")
    this.persistence = options.persistence
    this.limits = {
      maxRecordBytes: options.maxRecordBytes ?? 16 * 1024 * 1024,
      maxSnapshotBytes: options.maxSnapshotBytes ?? 64 * 1024 * 1024,
      maxRecords: options.maxRecords ?? 10000,
      batchRecords: options.batchRecords ?? 128,
      batchBytes: options.batchBytes ?? 1024 * 1024,
      replayEvents: options.replayEvents ?? 128,
      replayBytes: options.replayBytes ?? 4 * 1024 * 1024,
    }
    for (const value of Object.values(this.limits))
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new TypeError("Limits must be positive safe integers")
    this.bridge = new StorageBridge(
      options.storage,
      this.limits,
      (id, record) => this.persisted(id, record)
    )
    this.engine = this.createEngine()
  }
  private createEngine(): N.Subduction {
    // opts.signer is a JS Signer reference, NOT a consumed WASM pointer.
    return new N.Subduction({
      signer: this.signer,
      storage: this.bridge,
    })
  }
  private async resetEngine(): Promise<void> {
    try {
      await this.engine.disconnectAll()
    } finally {
      this.engine.free()
      this.engine = this.createEngine()
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
  private persisted(id: SedimentreeId, record: LooseCommitRecord): void {
    if (this.closed || this.deleting.has(id)) return
    const sequence = ++this.sequence
    for (const [watch, tree] of this.watches)
      if (tree === id)
        watch.push(
          { type: "records", sequence, phase: "live", records: [record] },
          recordBytes(record)
        )
    for (const watch of this.collections)
      watch.push({ type: "document", sequence, phase: "live", id })
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
  private async snapshot(id: SedimentreeId): Promise<LooseCommitRecord[]> {
    const native = nativeId(id)
    try {
      // This forces actual native hydration/validation on a fresh backend. Its
      // minimized metadata is deliberately NOT zipped with any blob enumeration.
      const records = await this.bridge.records(native)
      const commits = await this.engine.getCommits(native)
      commits?.forEach(c => c.free())
      return records
    } finally {
      native.free()
    }
  }
  private batches(
    records: readonly LooseCommitRecord[],
    sequence: number
  ): SedimentreeEvent[] {
    const events: SedimentreeEvent[] = []
    let batch: LooseCommitRecord[] = [],
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
      }
    )
    this.watches.set(watch, id)
    void this.enqueue("open", async () => {
      const records = await this.snapshot(id)
      const sequence = ++this.sequence
      watch.initialize([
        ...this.batches(records, sequence),
        {
          type: "local-load-complete",
          checkpoint: checkpoint(sequence, records),
          found: records.length > 0,
        },
      ])
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
          const roundId = `local-${++this.round}`
          const work = this.enqueue(
            "synchronize",
            async (): Promise<SyncRoundResult> => {
              const records = await this.snapshot(id)
              const result: SyncRoundResult = {
                roundId,
                checkpoint: checkpoint(++this.sequence, records),
                outcome: "no-peers",
                peers: [],
              }
              watch.push(
                { type: "synchronized", result },
                64 + result.checkpoint.heads.length * 32
              )
              return result
            }
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
      publishEphemeral: async () => {
        sessionCheck("ephemeral")
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
      const ids = await this.bridge.loadAllSedimentreeIds()
      try {
        const documents: CollectionObservation[] = []
        const sequence = ++this.sequence
        for (const native of ids) {
          const id = logicalId(native)
          await this.snapshot(id)
          documents.push({ type: "document", sequence, phase: "initial", id })
        }
        watch.initialize([
          ...documents,
          { type: "local-load-complete", sequence },
        ])
      } finally {
        ids.forEach(id => id.free())
      }
    }).catch(cause =>
      watch.finish({
        type: "failure",
        sequence: ++this.sequence,
        error: error("observe", cause, true),
      })
    )
    return watch
  }
  store(input: SedimentreeId, batch: RecordBatch): Promise<void> {
    try {
      const id = sedimentreeId(input)
      this.check("store", id)
      if (batch.some(r => r.kind === "fragment"))
        throw new BackendError(
          "store",
          "unsupported",
          "Commit-only adapter: fragment checkpoints are not exposed by @automerge/subduction 0.21.2"
        )
      let records: LooseCommitRecord[]
      try {
        records = batch.map(copyRecord) as LooseCommitRecord[]
        if (
          records.length > this.limits.batchRecords ||
          records.reduce((n, r) => n + recordBytes(r), 0) >
            this.limits.maxSnapshotBytes ||
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
      const work = this.enqueue("store", async () => {
        const native = nativeId(id)
        const inputs: N.CommitInput[] = []
        let submitted = false
        try {
          // Conservative exact policy prevents native minimization from silently
          // acknowledging variants that this experiment cannot preserve.
          const existing = new Map(
            (await this.bridge.records(native)).map(r => [r.id, r])
          )
          for (const record of records) {
            const old = existing.get(record.id)
            if (old && !equalRecords(old, record))
              throw new BackendError(
                "store",
                "conflict",
                "Different same-key representation is unsupported"
              )
            existing.set(record.id, record)
          }
          if (
            existing.size > this.limits.maxRecords ||
            [...existing.values()].reduce((n, r) => n + recordBytes(r), 0) >
              this.limits.maxSnapshotBytes
          )
            throw new BackendError(
              "store",
              "invalid-record",
              "Tree snapshot limit exceeded"
            )
          for (const record of records) {
            // CommitInput consumes LooseCommit. Never reuse/free that value.
            inputs.push(
              new N.CommitInput(unsigned(native, record), record.blob)
            )
          }
          if (inputs.length) {
            // storeBuiltBatch also consumes the CommitInput wrappers.
            submitted = true
            await this.engine.storeBuiltBatch(native, inputs, [])
          }
          // Success means EVERY record is recoverable, even if native minimized
          // its in-memory tree. Do not acknowledge silently discarded history.
          const stored = new Map(
            (await this.bridge.records(native)).map(r => [r.id, r])
          )
          for (const record of records)
            if (
              !stored.has(record.id) ||
              !equalRecords(stored.get(record.id)!, record)
            )
              throw new BackendError(
                "store",
                "io",
                "Native store did not persist all submitted history",
                true
              )
          // A watch opened while empty still needs a completeness marker when
          // history later arrives. Records alone cannot satisfy readiness.
          if (records.length && !this.closed && !this.deleting.has(id)) {
            const target = checkpoint(++this.sequence, [...stored.values()])
            for (const [watch, tree] of this.watches) {
              if (tree === id)
                watch.push(
                  { type: "checkpoint", checkpoint: target },
                  32 + target.heads.length * 32
                )
            }
          }
        } catch (cause) {
          this.requireRescan(id)
          await this.resetEngine()
          throw cause
        } finally {
          if (!submitted) inputs.forEach(c => c.free())
          native.free()
        }
      })
      const attempt = { id, work }
      this.attempts.add(attempt)
      // Successful settled work needs no ledger; failed attempts remain visible
      // until a captured flush/close barrier has reported them.
      void work.then(
        () => this.attempts.delete(attempt),
        () => {}
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
      return this.drain(captured).finally(() =>
        captured.forEach(a => this.attempts.delete(a))
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
      const sequence = ++this.sequence
      for (const [watch, tree] of this.watches)
        if (tree === id) watch.finish({ type: "deleted", sequence })
      const work = this.enqueue("delete", async () => {
        const native = nativeId(id)
        try {
          // Reject unsupported persisted fragments before native can erase them.
          await this.bridge.listFragmentIds(native)
          await this.engine.removeSedimentree(native)
          await this.bridge.cleanup(native)
          if (!this.closed)
            for (const watch of this.collections)
              watch.push({ type: "deleted", sequence: ++this.sequence, id })
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
    for (const watch of this.watches.keys()) watch.finish()
    for (const watch of this.collections) watch.finish()
    const captured = [...this.attempts]
    const deletions = [...this.deleting.values()]
    this.closing = (async () => {
      await this.tail
      const outcomes = await Promise.allSettled([
        this.drain(captured),
        ...deletions,
        this.engine.disconnectAll(),
      ])
      const errors = outcomes.flatMap(r =>
        r.status === "rejected" ? [r.reason] : []
      )
      try {
        this.engine.free()
      } catch (cause) {
        errors.push(cause)
      }
      this.attempts.clear()
      if (errors.length)
        throw new AggregateError(errors, "Backend close failed")
    })()
    return this.closing
  }
}
