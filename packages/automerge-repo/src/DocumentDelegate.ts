import { next as A } from "@automerge/automerge/slim"
import type { Document } from "./Document.js"
import type { DocHandle, StorageId, SyncInfo } from "./DocHandle.js"
import type { DocumentQuery } from "./DocumentQuery.js"
import { encodeHeads } from "./AutomergeUrl.js"
import { decode } from "./helpers/cbor.js"
import type { PeerId } from "./types.js"
import {
  copyRecord,
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
  #syncInfo = new Map<StorageId, SyncInfo>()
  #complete = false
  #localEmpty = false
  #closed = false
  #failed = false
  handle!: DocHandle<T>

  constructor(
    readonly id: SedimentreeId,
    readonly document: Document<T>,
    readonly query: DocumentQuery<T>,
    private submit: (id: SedimentreeId, records: RecordBatch) => Promise<void>,
    private synchronize: () => Promise<SyncRoundResult>
  ) {
    query.markInitialSnapshotPending()
    document.commit = doc => this.commit(doc)
    document.syncInfoLookup = id => this.#syncInfo.get(id)
  }

  attach(handle: DocHandle<T>, created = false): void {
    this.handle = handle
    this.#remember(this.document.doc)
    if (created) {
      this.#complete = true
      this.query.markInitialSnapshotComplete()
      this.query.sourceReady("backend")
    } else {
      this.query.sourcePending("backend")
    }
  }

  commit(doc: A.Doc<T>): Promise<void> {
    if (this.#closed || this.document.closed)
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

  /** Identify exact attempts covered by this delegate's retry barrier. */
  hasPendingWrite(attempt: Promise<unknown>): boolean {
    return [...this.#unsaved].some(job => job.pending === attempt)
  }

  onEvent(event: SedimentreeEvent): void {
    if (this.#closed || this.#failed || this.document.closed) return
    switch (event.type) {
      case "records": {
        const next = applyRecords(this.document.doc, event.records)
        // Inbound representation must be known before listeners can make edits.
        this.#remember(next)
        void this.document.applyMutation(() => next, { incoming: true })
        this.#checkTargets()
        break
      }
      case "local-load-complete":
        this.#localEmpty = !event.found
        this.#checkpoint("local", event.checkpoint)
        if (!this.#complete) void this.synchronize().catch(() => {})
        break
      case "checkpoint":
        this.#checkpoint("live", event.checkpoint)
        break
      case "synchronized": {
        this.#checkpoint("sync", event.result.checkpoint)
        const { outcome, peers } = event.result
        if (
          outcome !== "failed" &&
          !peers.some(peer => peer.outcome === "failed") &&
          !this.#complete &&
          this.#localEmpty &&
          this.#targets.size === 0 &&
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
        if (!event.error.retryable) this.fail(event.error)
        break
      case "deleted":
        this.markDeleted()
        break
      case "remote-heads": {
        const id = event.remote.id as StorageId
        const heads = encodeHeads([...event.heads])
        const timestamp = Date.now()
        this.#syncInfo.set(id, {
          lastHeads: heads,
          lastSyncTimestamp: timestamp,
        })
        this.document.registry.dispatchRemoteHeads(id, heads, timestamp)
        break
      }
      case "ephemeral":
        try {
          this.document.registry.dispatchEphemeral(
            event.message.origin.id as PeerId,
            decode(event.message.payload)
          )
        } catch (error) {
          this.document.log.error("invalid ephemeral message: %o", error)
        }
        break
      case "rescan-required":
        this.#targets.clear()
        this.#localEmpty = false
        if (!this.#complete) this.query.sourcePending("backend")
        break
    }
  }

  fail(reason: unknown): void {
    if (this.#failed) return
    this.#failed = true
    this.query.fail(
      reason instanceof Error ? reason : new Error(String(reason))
    )
  }

  /** Quiesce mutations without discarding accepted/failed persistence. */
  close(): void {
    this.#closed = true
    this.document.closed = true
  }

  markDeleted(): void {
    this.close()
    const notify = !this.document.deleted
    this.document.deleted = true
    this.#failed = true
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
    if (this.#failed || this.#complete || checkpoint.heads.length === 0) return
    if (!this.#targets.has(source)) this.#targets.set(source, checkpoint)
    this.#checkTargets()
  }

  #checkTargets(): void {
    if (this.#complete) return
    for (const target of this.#targets.values()) {
      if (satisfiesCheckpoint(this.document.doc, target.heads)) {
        this.#complete = true
        this.#targets.clear()
        this.query.markInitialSnapshotComplete()
        this.query.sourceReady("backend")
        return
      }
    }
  }
}
