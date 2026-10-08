import { next as A } from "@automerge/automerge/slim"
import type { Document } from "./Document.js"
import type { StorageId } from "./DocHandle.js"
import type { DocumentQuery } from "./DocumentQuery.js"
import { decode } from "./helpers/cbor.js"
import type { PeerId } from "./types.js"
import {
  copyRecord,
  recordHead,
  type HistoryCheckpoint,
  type RecordBatch,
  type SedimentreeEvent,
  type SedimentreeId,
  type SyncRoundResult,
} from "./sedimentree/index.js"
import {
  applyRecords,
  extractRecords,
  getRecordMetadata,
  recordMetadataKey,
  satisfiesCheckpoint,
} from "./sedimentree/automerge/index.js"

type WriteJob = {
  records: RecordBatch
  pending?: Promise<void>
  error?: unknown
}

/** Per-document CRDT consumer and owner of exact, retryable local write batches. */
export class DocumentDelegate<T> {
  #represented = new Set<string>()
  #unsaved = new Set<WriteJob>()
  #targets = new Map<"local" | "live" | "sync", HistoryCheckpoint>()
  /** Set by the scheduler; notifies the live session once a snapshot is verified. */
  onComplete?: () => void

  constructor(
    readonly id: SedimentreeId,
    readonly document: Document<T>,
    readonly query: DocumentQuery<T>,
    private submit: (id: SedimentreeId, records: RecordBatch) => Promise<void>,
    private synchronize: () => Promise<SyncRoundResult>,
    created = false,
    private origin?: string
  ) {
    document.commit = doc => this.commit(doc)
    this.#remember(this.document.doc)
    if (created) {
      this.query.markInitialSnapshotComplete()
      this.query.sourceReady("backend")
    } else {
      this.query.markInitialSnapshotPending()
      this.query.sourcePending("backend")
    }
  }

  /** Creation may finish while a lookup is already observing this document. */
  created(): void {
    this.#targets.clear()
    this.query.markInitialSnapshotComplete()
    this.query.sourceReady("backend")
  }

  commit(doc: A.Doc<T>): Promise<void> {
    if (this.document.closed)
      return Promise.reject(new Error("Delegate is closed"))
    const attempts = [...this.#unsaved].map(
      job => job.pending ?? this.#schedule(job)
    )
    const records = extractRecords(
      doc,
      meta => !this.#represented.has(recordMetadataKey(meta))
    )
    this.#remember(doc)
    if (records.length) {
      const job: WriteJob = { records }
      this.#unsaved.add(job)
      attempts.push(this.#schedule(job))
    }
    const stored = Promise.all(attempts).then(() => {})
    void stored.catch(() => {})
    return stored
  }

  #schedule(job: WriteJob, submit = this.submit): Promise<void> {
    // Give each attempt its own buffers; failed bytes remain unchanged for retry.
    let attempt: Promise<void>
    try {
      attempt = submit(this.id, job.records.map(copyRecord))
    } catch (error) {
      attempt = Promise.reject(error)
    }
    job.pending = attempt
    void attempt.then(
      () => {
        this.#unsaved.delete(job)
        job.pending = undefined
        job.error = undefined
      },
      error => {
        job.pending = undefined
        job.error = error
      }
    )
    return attempt
  }

  /** Capture now. Later edits are excluded, but retries may queue behind them. */
  async flush(submit = this.submit): Promise<void> {
    const captured = [...this.#unsaved]
    await Promise.allSettled(
      captured.flatMap(job => (job.pending ? [job.pending] : []))
    )
    await Promise.allSettled(
      captured
        .filter(job => this.#unsaved.has(job))
        .map(job => job.pending ?? this.#schedule(job, submit))
    )
    const failures = captured.filter(job => this.#unsaved.has(job))
    if (failures.length)
      throw new AggregateError(
        failures.map(
          job => job.error ?? new Error("Unstored document history")
        ),
        "Document still has unsaved history"
      )
  }

  drain(submit = this.submit): Promise<void> {
    return this.flush(submit)
  }

  get hasUnsavedHistory(): boolean {
    return this.#unsaved.size > 0
  }

  onEvent(event: SedimentreeEvent): void {
    if (this.document.closed || this.query.peek().state === "failed") return
    switch (event.type) {
      case "records": {
        // An applied head includes all its dependencies, even when delivered
        // through a fragment. Pending heads are not reported by hasHeads.
        // This is a materialization shortcut, not a persistence receipt.
        const unknown = event.records.filter(
          record => !A.hasHeads(this.document.doc, [recordHead(record)])
        )
        if (unknown.length) {
          const next = applyRecords(this.document.doc, unknown)
          // Inbound representation must be known before listeners can make edits.
          this.#remember(next)
          void this.document.applyMutation(() => next, { incoming: true })
        }
        this.#checkTargets()
        break
      }
      case "local-load-complete":
        this.#checkpoint("local", event.checkpoint)
        if (this.query.snapshotPending)
          void this.synchronize().catch(error => this.sourceUnavailable(error))
        break
      case "checkpoint":
        this.#checkpoint("live", event.checkpoint)
        break
      case "synchronized": {
        this.#checkpoint("sync", event.result.checkpoint)
        const { outcome, peers, checkpoint } = event.result
        if (
          this.query.snapshotPending &&
          this.#targets.size === 0 &&
          checkpoint.heads.length === 0 &&
          A.getHeads(this.document.doc).length === 0 &&
          (outcome === "no-peers" ||
            (outcome === "complete" &&
              peers.length > 0 &&
              peers.every(peer => peer.outcome === "unavailable")))
        ) {
          this.query.sourceUnavailable("backend")
        }
        break
      }
      case "failure":
        if (event.error.operation === "ephemeral") {
          try {
            this.document.log.error(
              "ephemeral operation failed: %o",
              event.error
            )
          } catch {
            // Application logging must not interrupt durable observation.
          }
        } else if (event.error.retryable)
          this.document.log.error("backend failure: %o", event.error)
        else this.sourceUnavailable(event.error)
        break
      case "deleted":
        this.markDeleted()
        break
      case "remote-heads": {
        const id = event.remote.id as StorageId
        this.document.recordRemoteHeads(id, event.heads)
        break
      }
      case "ephemeral":
        if (event.message.origin.id === this.origin) break
        try {
          this.document.registry.dispatchEphemeral(
            event.sender.id as PeerId,
            decode(new Uint8Array(event.message.payload))
          )
        } catch (error) {
          try {
            this.document.log.error("invalid ephemeral message: %o", error)
          } catch {
            // Application logging must not interrupt durable observation.
          }
        }
        break
      case "rescan-required":
        this.#targets.clear()
        if (this.query.snapshotPending) this.query.sourcePending("backend")
        break
    }
  }

  sourceUnavailable(reason: unknown): void {
    if (this.document.closed) return
    this.document.log.error("backend observation unavailable: %o", reason)
    this.query.sourceUnavailable("backend")
  }

  /** Quiesce mutations without discarding accepted/failed persistence. */
  close(): void {
    this.document.closed = true
  }

  markDeleted(): void {
    this.close()
    const notify = !this.document.deleted
    this.document.deleted = true
    // Invalidate acquisition before delete listeners can synchronously find the ID.
    this.query.fail(new Error("Document deleted"))
    if (notify) this.document.registry.dispatchDelete()
  }

  #remember(doc: A.Doc<T>): void {
    this.#represented = new Set(getRecordMetadata(doc).map(recordMetadataKey))
  }

  #checkpoint(
    source: "local" | "live" | "sync",
    checkpoint: HistoryCheckpoint
  ): void {
    if (
      this.query.peek().state === "failed" ||
      !this.query.snapshotPending ||
      checkpoint.heads.length === 0
    )
      return
    if (!this.#targets.has(source)) this.#targets.set(source, checkpoint)
    this.#checkTargets()
  }

  #checkTargets(): void {
    if (!this.query.snapshotPending) return
    for (const target of this.#targets.values()) {
      if (satisfiesCheckpoint(this.document.doc, target.heads)) {
        this.#targets.clear()
        this.query.markInitialSnapshotComplete()
        this.query.sourceReady("backend")
        this.onComplete?.()
        return
      }
    }
  }
}
