import { next as A } from "@automerge/automerge/slim"
import type { Document } from "./Document.js"
import type { RootQuery } from "./DocumentQuery.js"
import { decode } from "./helpers/cbor.js"
import type { PeerId, StorageId } from "./types.js"
import {
  checkpointForCommit,
  recordHead,
  type BackendIdentity,
  type CommitId,
  type FragmentRecord,
  type HistoryMarker,
  type RecordBatch,
  type SedimentreeBackend,
  type SedimentreeEvent,
  type SedimentreeId,
  type SedimentreeSession,
} from "./sedimentree/index.js"
import {
  applyRecords,
  extractFragments,
  extractNewCommits,
  isBoundary,
  satisfiesMarker,
} from "./sedimentree/automerge/index.js"
import { concatBytes } from "./sedimentree/concatBytes.js"

/** Compaction delay after a document first has a boundary due, plus jitter so
 * documents that become due together do not compact together. */
const COMPACTION_DELAY_MS = 10_000
const COMPACTION_JITTER_MS = 2_000
/** Longest a busy page can defer a due compaction once its timer has fired. */
const COMPACTION_IDLE_TIMEOUT_MS = 10_000

type IdleGlobal = {
  requestIdleCallback?: (
    callback: () => void,
    options?: { timeout: number }
  ) => number
  cancelIdleCallback?: (handle: number) => void
}

/** Run when the event loop is idle; returns a cancel function. */
function whenIdle(run: () => void): () => void {
  const idle = globalThis as IdleGlobal
  if (typeof idle.requestIdleCallback === "function") {
    const handle = idle.requestIdleCallback(run, {
      timeout: COMPACTION_IDLE_TIMEOUT_MS,
    })
    return () => idle.cancelIdleCallback?.(handle)
  }
  const timer = setTimeout(run, 0)
  ;(timer as { unref?: () => void }).unref?.()
  return () => clearTimeout(timer)
}

/**
 * Per-document backend consumer: owns the session, applies its events to the
 * CRDT and verifies readiness markers. Each edit is stored at once, without
 * ordering or batching; the backend owns those, durability, the flush barrier
 * and deletion fences. A failed store is not retried: the document stops
 * accepting local edits, and Repo reports the failure on every later flush.
 *
 * Edits are stored as loose commits. Boundary commits (which head a fragment)
 * are compacted later: once one is due, a jittered timer per document waits for
 * an idle moment, then the fragments are bundled and stored like any write.
 * Flush compacts at once. Due boundaries are learned from local edits and live
 * records only; history loaded from storage is not inspected.
 */
export class DocumentSync<T> {
  #targets = new Map<"local" | "live" | "sync", HistoryMarker>()
  /** Storage-scan bytes, applied together at the scan's local-load-complete. */
  #blobs: Uint8Array[] = []
  #session?: SedimentreeSession
  #consumer: Promise<void> = Promise.resolve()
  #deleted = false
  /** Boundary commits in the document with no covering fragment seen yet. */
  #due = new Set<CommitId>()
  #timer?: ReturnType<typeof setTimeout>
  #cancelIdle?: () => void
  #compacting: Promise<void> = Promise.resolve()
  #running = false

  constructor(
    readonly id: SedimentreeId,
    readonly document: Document<T>,
    readonly query: RootQuery<T>,
    private backend: SedimentreeBackend,
    private origin: BackendIdentity,
    created = false
  ) {
    document.commit = (before, after, options) =>
      this.commit(before, after, options)
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
    this.#blobs = []
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

  /** Store new changes as loose commits. Boundaries among them are compacted
   * later, or with `compact` (merges and imports) bundled into this batch. */
  commit(
    before: A.Doc<T>,
    after: A.Doc<T>,
    options: { compact?: boolean } = {}
  ): Promise<void> {
    const failure = this.document.writeFailure
    if (failure) return Promise.reject(failure.error)
    if (this.#deleted) return Promise.reject(new Error("Document deleted"))
    // The document has already adopted `after`: a failure to prepare its
    // records is a failed write, so it fail-stops like one.
    return this.#store(() => {
      const commits = extractNewCommits(before, after)
      if (!commits.length) return []
      const boundaries = commits.flatMap(c => (isBoundary(c.id) ? [c.id] : []))
      if (!options.compact) {
        for (const head of boundaries) this.#markDue(head)
        return commits
      }
      // Local changes are all in `after`, so an absent head was absorbed into
      // a higher fragment in the same batch.
      return [...commits, ...extractFragments(after, boundaries).records]
    })
  }

  /** Prepare and submit one batch; any failure fail-stops the document. */
  #store(prepare: () => RecordBatch): Promise<void> {
    let stored: Promise<void>
    try {
      const records = prepare()
      stored = records.length
        ? this.backend.store(this.id, records)
        : Promise.resolve()
    } catch (error) {
      stored = Promise.reject(error)
    }
    return stored.catch(error => {
      if (!this.#deleted) this.document.writeFailure ??= { error }
      throw error
    })
  }

  // -- Compaction --

  /** Bundle and store fragments for every due boundary now, after any run in
   * progress. When none is running, the store is submitted synchronously, so
   * a backend barrier taken right after includes it. Runs after close too, so
   * flush and shutdown can compact. */
  compactNow(): Promise<void> {
    this.#cancelScheduled()
    const run = this.#running
      ? this.#compacting.then(() => this.#compact())
      : this.#compact()
    this.#running = true
    const settled = run.catch(() => {})
    this.#compacting = settled
    void settled.then(() => {
      if (this.#compacting === settled) this.#running = false
    })
    return run
  }

  async #compact(): Promise<void> {
    if (!this.#due.size || this.#stopped) return
    const doc = this.document.peekDoc()
    if (!doc) return
    let fragments: FragmentRecord[] = []
    await this.#store(() => {
      const { records, absent } = extractFragments(doc, this.#due)
      // Absorbed into a higher fragment, unless the head is still pending.
      for (const head of absent)
        if (A.hasHeads(doc, [head])) this.#due.delete(head)
      fragments = records
      return records
    })
    for (const record of fragments) this.#due.delete(record.head)
  }

  /** Deleted (through Repo or a handle) or fail-stopped: no more stores. */
  get #stopped(): boolean {
    return (
      this.#deleted || this.document.deleted || !!this.document.writeFailure
    )
  }

  #markDue(head: CommitId): void {
    this.#due.add(head)
    this.#schedule()
  }

  /** Throttle per document: the first due boundary starts the timer. */
  #schedule(): void {
    if (this.#timer || this.#cancelIdle || !this.#due.size) return
    if (this.#stopped || this.document.closed) return
    const delay = COMPACTION_DELAY_MS + Math.random() * COMPACTION_JITTER_MS
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      this.#cancelIdle = whenIdle(() => {
        this.#cancelIdle = undefined
        // Heads left due are pending dependencies; later records re-arm.
        this.compactNow().catch(error =>
          this.#log("compaction failed: %o", error)
        )
      })
    }, delay)
    // Never keep a Node process alive just to compact.
    ;(this.#timer as { unref?: () => void }).unref?.()
  }

  #cancelScheduled(): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = undefined
    this.#cancelIdle?.()
    this.#cancelIdle = undefined
  }

  /** A fragment in storage covers its head and its checkpoint commits. */
  #covered(fragment: FragmentRecord): void {
    this.#due.delete(fragment.head)
    if (!fragment.checkpoints.length || !this.#due.size) return
    const checkpoints = new Set<string>(fragment.checkpoints)
    for (const head of this.#due)
      if (checkpoints.has(checkpointForCommit(head))) this.#due.delete(head)
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

  /** Stop edits; stores in flight can still be awaited with the backend's flush. */
  close(): void {
    this.#cancelScheduled()
    this.document.close()
  }

  /** Stop edits and stores, settle the query as deleted, and notify handles. */
  markDeleted(): void {
    this.close()
    this.#deleted = true
    this.#due.clear()
    this.#blobs = []
    this.document.delete()
  }

  /** Close the session, keeping it for a retry if closing fails. Interest
   * has ended, so nothing further is compacted. */
  async release(): Promise<void> {
    this.#cancelScheduled()
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
      case "blobs":
        this.#blobs.push(...event.blobs)
        break
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
          // Only commits new to the document can become due.
          for (const record of unknown)
            if (record.kind === "commit" && isBoundary(record.id))
              this.#due.add(record.id)
        }
        // Every stored fragment, including echoes of our own and those in
        // this same batch, covers its head and checkpoints.
        for (const record of event.records)
          if (record.kind === "fragment") this.#covered(record)
        // New records may also complete a due head's pending dependencies.
        if (unknown.length) this.#schedule()
        this.#checkTargets()
        break
      }
      case "local-load-complete":
        this.#applyBlobs()
        if (event.marker) this.#marker("local", event.marker)
        else if (event.found && this.document.heads().length) this.#complete()
        if (event.noPeers) this.#unavailable()
        if (this.query.pending && !event.backendSyncs)
          void this.#session?.synchronize().catch(error => this.fail(error))
        break
      case "history-marker":
        this.#marker("live", event.marker)
        break
      case "synchronized": {
        this.#marker("sync", event.result.marker)
        const { outcome, peers, marker } = event.result
        // Still empty and no peer supplied it: none has it, or none could be
        // reached. Later data can still make the document ready.
        if (
          this.query.pending &&
          this.#targets.size === 0 &&
          marker.heads.length === 0 &&
          this.document.heads().length === 0 &&
          (outcome === "no-peers" ||
            (peers.length > 0 &&
              peers.every(peer => peer.outcome !== "complete")))
        ) {
          this.#unavailable()
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
            decode(event.message.payload)
          )
        } catch (error) {
          this.#log("invalid ephemeral message: %o", error)
        }
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

  /** Apply a completed storage scan's blobs in one update. */
  #applyBlobs(): void {
    const input = concatBytes(this.#blobs)
    this.#blobs = []
    if (!input.byteLength) return
    const current = this.document.peekDoc()
    if (!current) {
      // The first scan can become the document directly. A crash mid-flush
      // or an interrupted sync can leave a record on disk without its
      // parents; load the complete prefix and keep the rest pending.
      const next = A.load<T>(input, { allowMissingChanges: true })
      void this.document.applyLoaded(next, this.query.pending)
    } else {
      const next = A.loadIncremental(current, input)
      void this.document.applyMutation(() => next, {
        incoming: true,
        initial: this.query.pending,
      })
    }
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
    this.document.flushRemoteHeads()
    // Let the backend skip history-marker work once Repo has a verified snapshot.
    this.#session?.markComplete?.()
  }

  #unavailable(): void {
    if (!this.query.pending) return
    this.document.discardRemoteHeads()
    this.query.unavailable()
  }
}
