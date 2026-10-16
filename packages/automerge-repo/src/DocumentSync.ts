import { next as A } from "@automerge/automerge/slim"
import type { Document } from "./Document.js"
import type { RootQuery } from "./DocumentQuery.js"
import { decode } from "./helpers/cbor.js"
import type { PeerId, StorageId } from "./types.js"
import {
  recordHead,
  type BackendIdentity,
  type HistoryMarker,
  type RecordBatch,
  type SedimentreeBackend,
  type SedimentreeEvent,
  type SedimentreeId,
  type SedimentreeSession,
} from "./sedimentree/index.js"
import {
  applyRecords,
  extractNewRecords,
  satisfiesMarker,
} from "./sedimentree/automerge/index.js"
import { concatBytes } from "./sedimentree/concatBytes.js"

type WriteJob = {
  records: RecordBatch
  error?: unknown
}

/**
 * Per-document backend consumer: owns the session, applies its events to the
 * CRDT, verifies readiness markers, and keeps exact unsaved write batches so
 * failed stores can be retried. Writes are ordered per document; the backend
 * owns durability, deletion fences and the flush barrier.
 */
export class DocumentSync<T> {
  #unsaved: WriteJob[] = []
  #tail: Promise<void> = Promise.resolve()
  #running = false
  /** A store that has not started yet; edits made meanwhile join it. */
  #queued?: Promise<void>
  #targets = new Map<"local" | "live" | "sync", HistoryMarker>()
  #session?: SedimentreeSession
  #consumer: Promise<void> = Promise.resolve()
  #deleted = false

  constructor(
    readonly id: SedimentreeId,
    readonly document: Document<T>,
    readonly query: RootQuery<T>,
    private backend: SedimentreeBackend,
    private origin: BackendIdentity,
    created = false
  ) {
    document.commit = (before, after) => this.commit(before, after)
    document.publishEphemeral = payload =>
      this.publishEphemeral(payload).catch(error =>
        this.#log("ephemeral publication failed: %o", error)
      )
    if (created) this.#complete()
  }

  /** Open the backend session and start consuming its events. */
  start(): void {
    if (this.document.closed || this.#session) return
    let session: SedimentreeSession
    try {
      session = this.backend.open(this.id)
    } catch (error) {
      this.fail(error)
      return
    }
    this.#session = session
    if (!this.query.pending) session.markComplete?.()
    this.#consumer = this.#consume(session).catch(error => {
      if (this.#session !== session) return
      this.#session = undefined
      this.fail(error)
    })
  }

  /** Resolves once the current event loop has ended. */
  settled(): Promise<void> {
    return this.#consumer
  }

  async #consume(session: SedimentreeSession): Promise<void> {
    for await (const event of session.events) {
      if (this.#session !== session) return
      if (event.type === "rescan-required") {
        this.onEvent(event)
        this.#session = undefined
        try {
          await session.close()
        } catch (error) {
          this.#log("failed to close a rescanned session: %o", error)
        }
        this.start()
        return
      }
      if (event.type === "deleted") {
        this.#session = undefined
        try {
          this.markDeleted()
        } finally {
          await session.close()
        }
        return
      }
      this.onEvent(event)
    }
    if (this.#session === session && !this.document.closed)
      this.fail(new Error("Backend observation ended"))
  }

  // -- Writes --

  commit(before: A.Doc<T>, after: A.Doc<T>): Promise<void> {
    const records = extractNewRecords(before, after)
    if (records.length) this.#unsaved.push({ records })
    if (!this.#unsaved.length) return Promise.resolve()
    return this.#store()
  }

  /** One store in flight per document, started at once when idle; edits made
   * meanwhile join the next one. */
  #store(): Promise<void> {
    if (this.#queued) return this.#queued
    const idle = !this.#running
    const job = idle ? this.#persist() : this.#tail.then(() => this.#persist())
    if (!idle) this.#queued = job
    this.#tail = job.catch(() => {})
    return job
  }

  async #persist(): Promise<void> {
    this.#queued = undefined
    this.#running = true
    try {
      if (this.#deleted) throw new Error("Document deleted")
      const jobs = [...this.#unsaved]
      if (!jobs.length) return
      try {
        await this.backend.store(
          this.id,
          jobs.flatMap(job => job.records)
        )
      } catch (error) {
        for (const job of jobs) job.error = error
        throw error
      }
      this.#unsaved = this.#unsaved.filter(job => !jobs.includes(job))
    } finally {
      this.#running = false
    }
  }

  get hasUnsavedHistory(): boolean {
    return this.#unsaved.length > 0
  }

  /** Wait for captured writes, retry captured failures once, then report. */
  async flush(): Promise<void> {
    const captured = [...this.#unsaved]
    if (!captured.length) return
    await this.#tail
    if (!this.#deleted && captured.some(job => this.#unsaved.includes(job)))
      await this.#store().catch(() => {})
    const failures = captured.filter(job => this.#unsaved.includes(job))
    if (failures.length)
      throw new AggregateError(
        [
          ...new Set(
            failures.map(
              job => job.error ?? new Error("Unstored document history")
            )
          ),
        ],
        "Document still has unsaved history"
      )
  }

  // -- Lifecycle --

  /** Creation finished while a lookup was already observing this document. */
  adopt(doc: A.Doc<T>): void {
    void this.document.applyMutation(
      current => A.merge(current, A.clone(doc)),
      { incoming: true, initial: this.query.pending }
    )
    this.#complete()
  }

  async publishEphemeral(payload: Uint8Array): Promise<void> {
    const session = this.#session
    if (!session || this.document.closed) throw new Error("No active session")
    await session.publishEphemeral({
      messageId: crypto.randomUUID(),
      origin: this.origin,
      payload,
    })
  }

  /** Stop edits; unsaved history can still be drained with flush(). */
  close(): void {
    this.document.close()
  }

  /** Stop edits and stores, settle the query as deleted, and notify handles. */
  markDeleted(): void {
    this.close()
    this.#deleted = true
    // Nothing more reaches the backend, so there is nothing left to report.
    this.#unsaved = []
    this.document.delete()
  }

  /** Settles once the store in flight (if any) has. */
  idle(): Promise<void> {
    return this.#tail
  }

  /** Close the session, keeping it for a retry if closing fails. */
  async release(): Promise<void> {
    const session = this.#session
    if (!session) return
    this.#session = undefined
    try {
      await session.close()
    } catch (error) {
      this.#session ??= session
      throw error
    }
  }

  // -- Events --

  onEvent(event: SedimentreeEvent): void {
    if (this.document.closed || this.query.terminal) return
    switch (event.type) {
      case "blobs": {
        const input = concatBytes(event.blobs)
        if (!input.byteLength) break
        const current = this.document.peekDoc()
        if (!current) {
          // The initial storage batch can become the document directly.
          const next = A.load<T>(input, { allowMissingChanges: true })
          void this.document.applyLoaded(next, this.query.pending)
        } else {
          const next = A.loadIncremental(current, input)
          void this.document.applyMutation(() => next, {
            incoming: true,
            initial: this.query.pending,
          })
        }
        break
      }
      case "records": {
        // An applied head includes all its dependencies, even when delivered
        // through a fragment. Pending heads are not reported by hasHeads.
        // This is a materialization shortcut, not a persistence receipt.
        const current = this.document.peekDoc()
        const unknown = current
          ? event.records.filter(
              record => !A.hasHeads(current, [recordHead(record)])
            )
          : event.records
        if (unknown.length) {
          const next = applyRecords(this.document.doc, unknown)
          void this.document.applyMutation(() => next, {
            incoming: true,
            initial: this.query.pending,
          })
        }
        this.#checkTargets()
        break
      }
      case "local-load-complete":
        if (event.marker) this.#marker("local", event.marker)
        else if (event.found && this.document.heads().length) this.#complete()
        if (event.noPeers) this.query.unavailable()
        if (this.query.pending && !event.backendSyncs)
          void this.#session?.synchronize().catch(error => this.fail(error))
        break
      case "history-marker":
        this.#marker("live", event.marker)
        break
      case "synchronized": {
        this.#marker("sync", event.result.marker)
        const { outcome, peers, marker } = event.result
        if (
          this.query.pending &&
          this.#targets.size === 0 &&
          marker.heads.length === 0 &&
          this.document.heads().length === 0 &&
          (outcome === "no-peers" ||
            (outcome === "complete" &&
              peers.length > 0 &&
              peers.every(peer => peer.outcome === "unavailable")))
        ) {
          this.query.unavailable()
        }
        break
      }
      case "failure":
        if (event.error.operation === "ephemeral") {
          this.#log("ephemeral operation failed: %o", event.error)
        } else if (event.error.retryable)
          this.#log("backend failure: %o", event.error)
        else this.fail(event.error)
        break
      case "remote-heads":
        this.document.recordRemoteHeads(
          event.remote.id as StorageId,
          event.heads
        )
        break
      case "ephemeral":
        if (event.message.origin.id === this.origin.id) break
        try {
          this.document.registry.dispatchEphemeral(
            event.sender.id as PeerId,
            decode(new Uint8Array(event.message.payload))
          )
        } catch (error) {
          this.#log("invalid ephemeral message: %o", error)
        }
        break
      case "rescan-required":
        this.#targets.clear()
        this.query.loading()
        break
    }
  }

  /** Terminal: stop edits and surface the error through the query. */
  fail(reason: unknown): void {
    if (this.document.closed) return
    this.#log("backend observation failed: %o", reason)
    this.close()
    this.query.fail(
      reason instanceof Error ? reason : new Error(String(reason))
    )
  }

  /** Application logging must not interrupt durable observation. */
  #log(message: string, detail: unknown): void {
    try {
      this.document.log.error(message, detail)
    } catch {}
  }

  #marker(source: "local" | "live" | "sync", marker: HistoryMarker): void {
    if (!this.query.pending || marker.heads.length === 0) return
    if (!this.#targets.has(source)) this.#targets.set(source, marker)
    this.#checkTargets()
  }

  #checkTargets(): void {
    if (!this.query.pending) return
    const doc = this.document.peekDoc()
    if (!doc) return
    for (const target of this.#targets.values()) {
      if (satisfiesMarker(doc, target.heads)) {
        this.#complete()
        return
      }
    }
  }

  #complete(): void {
    this.#targets.clear()
    this.query.ready()
    // Let the backend skip history-marker work once Repo has a verified snapshot.
    this.#session?.markComplete?.()
  }
}
