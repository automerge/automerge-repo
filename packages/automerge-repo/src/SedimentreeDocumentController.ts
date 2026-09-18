import { next as A } from "@automerge/automerge/slim"
import type {
  HistoryCheckpoint,
  RecordBatch,
  SedimentreeBackend,
  SedimentreeId,
  SedimentreeSession,
  SyncRoundResult,
} from "@automerge/automerge-repo-sedimentree"
import {
  applyRecords,
  extractRecords,
  getRecordMetadata,
  recordMetadataKey,
  satisfiesCheckpoint,
} from "@automerge/automerge-repo-sedimentree-automerge"
import { Document } from "./Document.js"
import { DocHandle } from "./DocHandle.js"
import { DocumentQuery, type DocumentProgress } from "./DocumentQuery.js"
import type { DocumentId } from "./types.js"

interface WriteJob {
  readonly records: RecordBatch
  scheduled: boolean
  error?: Error
}

/**
 * Private experimental bridge, deliberately not wired into Repo or its exports.
 * The caller owns the backend and must quiesce handle edits before close().
 * No network handle, ephemeral, or remote-heads integration is provided here.
 */
export class SedimentreeDocumentController<T = unknown> {
  readonly document: Document<T>
  readonly handle: DocHandle<T>
  readonly query: DocumentProgress<T>
  lastError: Error | undefined

  readonly #backend: SedimentreeBackend
  readonly #id: SedimentreeId
  readonly #query: DocumentQuery<T>
  readonly #onError?: (error: Error) => void
  // Representation bookkeeping is replaced on every snapshot, not accumulated.
  #represented = new Set<string>()
  // Durability is independent of representation: even a self-echo must not
  // acknowledge a failed, possibly partially persisted batch.
  #jobs = new Set<WriteJob>()
  #tail: Promise<void> = Promise.resolve()
  #session?: SedimentreeSession
  #stopped = false
  #generationDeleted = false
  #closing?: Promise<void>
  #deleting?: Promise<void>
  #complete = false
  // Coalesce checkpoints by source, never by sequence or round ID.
  #targets = new Map<"local" | "live" | "sync", HistoryCheckpoint>()
  #localEmpty = false

  constructor(options: {
    backend: SedimentreeBackend
    id: SedimentreeId
    documentId: DocumentId
    initialDoc?: A.Doc<T>
    onError?: (error: Error) => void
  }) {
    this.#backend = options.backend
    this.#id = options.id
    this.#onError = options.onError
    let initialDoc = options.initialDoc ?? A.init<T>()
    // Empty creation still needs durable history to distinguish it from absence.
    if (options.initialDoc && A.getHeads(initialDoc).length === 0) {
      initialDoc = A.emptyChange(initialDoc)
    }
    this.document = new Document(options.documentId, initialDoc)
    this.handle = new DocHandle(this.document)
    this.#query = new DocumentQuery(
      this.handle,
      new Map([["sedimentree", { priority: 0 }]]),
      { initialSnapshotPending: true }
    )
    this.query = this.#query
    this.handle.on("heads-changed", this.#onHeadsChanged)
    // Creation is itself a write, even if no subsequent edit ever occurs.
    this.#capture()
    if (options.initialDoc) this.#markComplete()
    this.#open()
  }

  #report(error: unknown): Error {
    const normalized = error instanceof Error ? error : new Error(String(error))
    this.lastError = normalized
    try {
      this.#onError?.(normalized)
    } catch {
      // An error observer must not create an unhandled queue rejection.
    }
    return normalized
  }

  #onHeadsChanged = (): void => {
    if (this.#stopped) return
    try {
      this.#capture()
      this.#checkTargets()
    } catch (error) {
      this.#report(error)
    }
  }

  #remember(doc: A.Doc<T>): void {
    this.#represented = new Set(getRecordMetadata(doc).map(recordMetadataKey))
  }

  #capture(): void {
    const records = extractRecords(
      this.document.doc,
      meta => !this.#represented.has(recordMetadataKey(meta))
    )
    this.#remember(this.document.doc)
    if (!records.length) return
    const job: WriteJob = { records, scheduled: false }
    this.#jobs.add(job)
    this.#schedule(job)
  }

  #enqueue(work: () => Promise<void>): Promise<void> {
    const result = this.#tail.then(work)
    this.#tail = result.catch(error => {
      this.#report(error)
    })
    return result
  }

  #schedule(job: WriteJob): void {
    job.scheduled = true
    void this.#enqueue(async () => {
      job.error = undefined
      try {
        // A backend-initiated deletion has already invalidated this generation.
        // Unlike our own deleteLocal barrier, queued but unsubmitted work must
        // not reacquire the ID after that deletion.
        if (this.#generationDeleted)
          throw new Error("Document generation deleted")
        await this.#backend.store(this.#id, job.records)
        this.#jobs.delete(job)
      } catch (error) {
        job.error = this.#report(error)
      } finally {
        job.scheduled = false
      }
    })
  }

  /** Retry previously failed jobs; fence all captured attempts before later edits. */
  flush(): Promise<void> {
    if (this.#stopped) return Promise.reject(new Error("Controller is closed"))
    this.#capture()
    return this.#flushCaptured()
  }

  #flushCaptured(): Promise<void> {
    const captured = [...this.#jobs]
    for (const job of captured) {
      if (!job.scheduled) this.#schedule(job)
    }
    // Enqueue the backend barrier now, not after awaiting writes: later edits
    // must not get in front of this flush (including overlapping flush calls).
    return this.#enqueue(async () => {
      const errors = captured.flatMap(job => (job.error ? [job.error] : []))
      try {
        await this.#backend.flush([this.#id])
      } catch (error) {
        errors.push(this.#report(error))
      }
      if (errors.length)
        throw new AggregateError(errors, "Sedimentree flush failed")
    })
  }

  synchronize(): Promise<SyncRoundResult> {
    if (this.#stopped || !this.#session) {
      return Promise.reject(new Error("Controller has no active session"))
    }
    // Readiness is driven exclusively by consuming the correlated stream event.
    return this.#session.synchronize().catch(error => {
      throw this.#report(error)
    })
  }

  #open(): void {
    if (this.#stopped) return
    try {
      const session = this.#backend.open(this.#id)
      this.#session = session
      this.#localEmpty = false
      // An earlier cut is still sufficient if its missing dependencies arrive
      // during the rescan. Keep the bounded, pinned targets until satisfied.
      if (!this.#complete) this.#query.sourcePending("sedimentree")
      void this.#consume(session).catch(error => {
        const reported = this.#report(error)
        if (this.#stopped || this.#session !== session) return
        this.#query.fail(reported)
        void session.close().catch(error => {
          this.#report(error)
        })
      })
    } catch (error) {
      this.#query.fail(this.#report(error))
    }
  }

  async #consume(session: SedimentreeSession): Promise<void> {
    for await (const event of session.events) {
      if (this.#stopped || this.#session !== session) return
      switch (event.type) {
        case "records":
          this.#capture()
          this.document.applyMutation(doc => {
            const next = applyRecords(doc, event.records)
            // Remember BEFORE dispatch. A user callback may synchronously make
            // a local edit, which must be captured rather than suppressed.
            this.#remember(next)
            return next
          })
          this.#checkTargets()
          break
        case "local-load-complete":
          this.#localEmpty = !event.found
          this.#checkpoint("local", event.checkpoint)
          if (!this.#complete) {
            void this.synchronize().catch(() => {
              /* exposed via lastError */
            })
          }
          break
        case "checkpoint":
          this.#checkpoint("live", event.checkpoint)
          break
        case "synchronized": {
          const result = event.result
          this.#checkpoint("sync", result.checkpoint)
          const absent =
            result.outcome === "no-peers" ||
            (result.outcome === "complete" &&
              result.peers.length > 0 &&
              result.peers.every(peer => peer.outcome === "unavailable"))
          if (
            result.outcome === "failed" ||
            result.peers.some(p => p.outcome === "failed")
          ) {
            this.#report(
              result.peers.find(p => p.error)?.error ??
                new Error("Synchronization failed")
            )
          } else if (
            absent &&
            this.#localEmpty &&
            !this.#complete &&
            this.#targets.size === 0 &&
            A.getHeads(this.document.doc).length === 0
          ) {
            this.#query.sourceUnavailable("sedimentree")
          }
          break
        }
        case "failure":
          this.#report(event.error)
          if (!event.error.retryable) {
            this.#query.fail(event.error)
            await session.close()
            return
          }
          break
        case "rescan-required":
          await session.close()
          if (this.#stopped || this.#session !== session) return
          this.#open()
          return
        case "deleted":
          this.#generationDeleted = true
          this.#stop(new Error("Document deleted"))
          this.#query.fail(new Error("Document deleted"))
          if (!this.document.deleted) this.handle.delete()
          await session.close()
          return
        // Not integrated with DocHandle's network/ephemeral APIs.
        case "remote-heads":
        case "ephemeral":
          break
      }
    }
    if (!this.#stopped && this.#session === session) {
      throw new Error("Sedimentree observation ended")
    }
  }

  #checkpoint(
    source: "local" | "live" | "sync",
    checkpoint: HistoryCheckpoint
  ): void {
    if (this.#complete || checkpoint.heads.length === 0) return
    // Pin the first nonempty cut for each source until it is satisfied. Replacing
    // it with every newer frontier can make a busy source postpone readiness
    // forever, even after its original initial snapshot has been reconstructed.
    if (!this.#targets.has(source)) this.#targets.set(source, checkpoint)
    this.#checkTargets()
  }

  #checkTargets(): void {
    for (const target of this.#targets.values()) {
      if (satisfiesCheckpoint(this.document.doc, target.heads)) {
        this.#markComplete()
        return
      }
    }
  }

  #markComplete(): void {
    this.#complete = true
    this.#targets.clear()
    this.#query.markInitialSnapshotComplete()
    this.#query.sourceReady("sedimentree")
  }

  #stop(error: Error): void {
    this.#stopped = true
    this.handle.off("heads-changed", this.#onHeadsChanged)
    this.#targets.clear()
    if (this.query.peek().state === "loading") this.#query.fail(error)
  }

  /** Caller must stop editing first. Does not close the shared backend. */
  close(): Promise<void> {
    if (this.#closing) return this.#closing
    if (!this.#stopped) this.#capture()
    this.#stop(new Error("Controller closed before initial snapshot completed"))
    const session = this.#session
    this.#closing = (async () => {
      // Release observation independently of persistence. A hanging accepted
      // write may hold close pending, but must not retain an idle watch too.
      const outcomes = await Promise.allSettled([
        this.#flushCaptured(),
        Promise.resolve().then(() => session?.close()),
      ])
      const errors = outcomes.flatMap(result =>
        result.status === "rejected" ? [this.#report(result.reason)] : []
      )
      if (errors.length)
        throw new AggregateError(errors, "Controller close failed")
    })()
    return this.#closing
  }

  /** Invalidate immediately, but order removal after all older store attempts. */
  deleteLocal(): Promise<void> {
    if (this.#deleting) return this.#deleting
    const closing = this.close()
    this.#query.fail(new Error("Document deleted"))
    if (!this.document.deleted) this.handle.delete()
    this.#deleting = (async () => {
      const errors: unknown[] = []
      try {
        await closing
      } catch (error) {
        errors.push(error)
      }
      try {
        await this.#backend.deleteLocal(this.#id)
      } catch (error) {
        errors.push(this.#report(error))
      }
      if (errors.length)
        throw new AggregateError(errors, "Controller deletion failed")
    })()
    return this.#deleting
  }
}
