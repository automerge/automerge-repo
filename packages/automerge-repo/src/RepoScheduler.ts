import {
  copyRecord,
  type EphemeralEnvelope,
  type RecordBatch,
  type SedimentreeBackend,
  type SedimentreeId,
  type SedimentreeSession,
  type SyncRoundResult,
} from "./sedimentree/index.js"
import type { DocumentDelegate } from "./DocumentDelegate.js"

type Delegate = DocumentDelegate<any>

/** Prepare and acknowledge a write inside the scheduler's per-document queue. */
export type WriteSource = (
  submitRecords: (records: RecordBatch) => Promise<void>
) => Promise<void>

/** Owns backend sessions and ordered per-ID persistence, bounded across IDs. */
export class RepoScheduler {
  #tails = new Map<SedimentreeId, Promise<void>>()
  #queued = new Map<
    SedimentreeId,
    { source: WriteSource; job: Promise<void> }
  >()
  #creating = new Map<Promise<unknown>, SedimentreeId | undefined>()
  #sessions = new Map<Delegate, SedimentreeSession>()
  #delegates = new Set<Delegate>()
  #consumers = new Set<Promise<void>>()
  #generations = new Map<SedimentreeId, number>()
  #deleting = new Map<SedimentreeId, Promise<void>>()
  #detaching = new Map<Delegate, Promise<void>>()
  #active = 0
  #waiting: (() => void)[] = []
  #closing?: Promise<void>
  #stopping = false
  readonly #concurrency: number

  constructor(
    private backend: SedimentreeBackend,
    options: { concurrency?: number } = {}
  ) {
    this.#concurrency = options.concurrency ?? 4
    if (!Number.isSafeInteger(this.#concurrency) || this.#concurrency < 1)
      throw new RangeError("Concurrency must be a positive integer")
  }

  create(
    records: RecordBatch,
    options?: { documentId?: SedimentreeId }
  ): Promise<SedimentreeId> {
    if (this.#stopping) return Promise.reject(new Error("Scheduler is closed"))
    if (options?.documentId && this.#deleting.has(options.documentId))
      return Promise.reject(new Error("Document deletion in progress"))
    const owned = records.map(copyRecord)
    const requested = options?.documentId
    if (requested) this.#queued.delete(requested)
    const generation = requested ? (this.#generations.get(requested) ?? 0) : 0
    const previous = requested
      ? (this.#tails.get(requested) ?? Promise.resolve())
      : Promise.resolve()
    const job = previous.then(() =>
      this.#run(() => {
        if (requested && (this.#generations.get(requested) ?? 0) !== generation)
          throw new Error("Document generation deleted")
        return this.backend.create(
          owned,
          requested ? { documentId: requested } : undefined
        )
      })
    )
    if (requested) this.#setTail(requested, job)
    this.#creating.set(job, requested)
    void job.then(
      () => this.#creating.delete(job),
      () => this.#creating.delete(job)
    )
    return job
  }

  submit(id: SedimentreeId, records: RecordBatch | WriteSource): Promise<void> {
    return this.#submit(id, records)
  }

  #submit(
    id: SedimentreeId,
    records: RecordBatch | WriteSource,
    draining = false
  ): Promise<void> {
    if (this.#stopping && !draining)
      return Promise.reject(new Error("Scheduler is closed"))
    if (this.#deleting.has(id))
      return Promise.reject(new Error("Document deletion in progress"))
    const source = typeof records === "function" ? records : undefined
    const queued = this.#queued.get(id)
    if (source && queued?.source === source) return queued.job
    // Raw submissions and different producers preserve their position in the queue.
    this.#queued.delete(id)
    const owned = source ? undefined : (records as RecordBatch).map(copyRecord)
    const generation = this.#generations.get(id) ?? 0
    const previous = this.#tails.get(id) ?? Promise.resolve()
    const job = previous.then(() =>
      this.#run(async () => {
        if (this.#queued.get(id)?.job === job) this.#queued.delete(id)
        if ((this.#generations.get(id) ?? 0) !== generation)
          throw new Error("Document generation deleted")
        const submitRecords = (batch: RecordBatch) =>
          batch.length
            ? this.backend.store(id, batch.map(copyRecord))
            : Promise.resolve()
        if (source) await source(submitRecords)
        else await submitRecords(owned!)
      })
    )
    this.#setTail(id, job)
    if (source) this.#queued.set(id, { source, job })
    return job
  }

  #setTail(id: SedimentreeId, job: Promise<unknown>): void {
    const tail = job.then(
      () => {},
      () => {}
    )
    this.#tails.set(id, tail)
    void tail.then(() => {
      if (this.#tails.get(id) === tail) this.#tails.delete(id)
    })
  }

  async #run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#active >= this.#concurrency)
      await new Promise<void>(resolve => this.#waiting.push(resolve))
    else this.#active++
    try {
      return await operation()
    } finally {
      const next = this.#waiting.shift()
      if (next) next()
      else this.#active--
    }
  }

  /** Capture submitted work and delegate retries at the call. */
  flush(ids?: readonly SedimentreeId[]): Promise<void> {
    const selected = ids && [...ids]
    const targets = selected && new Set(selected)
    const delegates = [...this.#delegates].filter(
      delegate => !targets || targets.has(delegate.id)
    )
    const tails = [...this.#tails].filter(([id]) => !targets || targets.has(id))
    const creations = [...this.#creating]
      .filter(([, id]) => !targets || (id !== undefined && targets.has(id)))
      .map(([job]) => job)
    const deletions = [...this.#deleting].filter(
      ([id]) => !targets || targets.has(id)
    )
    const detachments = [...this.#detaching].filter(
      ([delegate]) => !targets || targets.has(delegate.id)
    )
    const drains = delegates
      .filter(delegate => delegate.hasUnsavedHistory)
      .map(delegate => delegate.flush())
    const pending = [
      ...tails.map(([, tail]) => tail),
      ...creations,
      ...deletions.map(([, job]) => job),
      ...detachments.map(([, job]) => job),
      ...drains,
    ]
    // With no pending submissions, capture the backend barrier before later edits.
    let barrier: Promise<void> | undefined
    if (!pending.length) {
      try {
        barrier = this.backend.flush(selected)
      } catch (error) {
        barrier = Promise.reject(error)
      }
    }
    return (async () => {
      const results = await Promise.allSettled(pending)
      const errors = results
        .filter(result => result.status === "rejected")
        .map(result => result.reason)
      try {
        await (barrier ?? this.backend.flush(selected))
      } catch (error) {
        errors.push(error)
      }
      if (errors.length) throw new AggregateError(errors, "Repo flush failed")
    })()
  }

  open<T>(delegate: DocumentDelegate<T>): void {
    if (this.#stopping) throw new Error("Scheduler is closed")
    if (this.#deleting.has(delegate.id))
      throw new Error("Document deletion in progress")
    if (delegate.document.closed) throw new Error("Document is closed")
    if (this.#sessions.has(delegate)) return
    const session = this.backend.open(delegate.id)
    this.#delegates.add(delegate)
    this.#sessions.set(delegate, session)
    // Let the backend skip checkpoint work once Repo has a verified snapshot.
    delegate.onComplete = () => {
      if (this.#sessions.get(delegate) === session) session.markComplete?.()
    }
    if (!delegate.query.snapshotPending) delegate.onComplete()
    const consumer = this.#consume(delegate, session)
    this.#consumers.add(consumer)
    void consumer.then(
      () => this.#consumers.delete(consumer),
      error => {
        this.#consumers.delete(consumer)
        if (!this.#stopping && this.#delegates.has(delegate))
          delegate.sourceUnavailable(error)
      }
    )
  }

  synchronize<T>(delegate: DocumentDelegate<T>): Promise<SyncRoundResult> {
    const session = this.#sessions.get(delegate)
    return !this.#stopping && session
      ? session.synchronize()
      : Promise.reject(new Error("No active session"))
  }

  async publishEphemeral<T>(
    delegate: DocumentDelegate<T>,
    message: EphemeralEnvelope
  ): Promise<void> {
    const session = this.#sessions.get(delegate)
    return !this.#stopping && session
      ? session.publishEphemeral(message)
      : Promise.reject(new Error("No active session"))
  }

  async #consume(
    delegate: Delegate,
    session: SedimentreeSession
  ): Promise<void> {
    for await (const event of session.events) {
      if (this.#stopping || this.#sessions.get(delegate) !== session) return
      if (event.type === "rescan-required") {
        delegate.onEvent(event)
        this.#sessions.delete(delegate)
        await session.close()
        if (
          !this.#stopping &&
          !this.#deleting.has(delegate.id) &&
          !delegate.document.closed
        )
          this.open(delegate)
        return
      }
      if (event.type === "deleted") {
        this.#generations.set(
          delegate.id,
          (this.#generations.get(delegate.id) ?? 0) + 1
        )
        this.#sessions.delete(delegate)
        this.#delegates.delete(delegate)
        try {
          delegate.onEvent(event)
        } finally {
          await session.close()
        }
        return
      }
      delegate.onEvent(event)
    }
    if (!this.#stopping && this.#sessions.get(delegate) === session)
      delegate.sourceUnavailable(new Error("Backend observation ended"))
  }

  /** Drain local history, release interest, and retain stored history. */
  detach<T>(delegate: DocumentDelegate<T>): Promise<void> {
    const existing = this.#detaching.get(delegate)
    if (existing) return existing
    if (this.#stopping) return Promise.reject(new Error("Scheduler is closed"))
    // Stop edits before capturing; otherwise retained handles can outlive eviction.
    delegate.document.closed = true
    this.#delegates.add(delegate)
    const job = this.flush([delegate.id]).then(async () => {
      delegate.close()
      const session = this.#sessions.get(delegate)
      this.#sessions.delete(delegate)
      if (session) {
        try {
          await session.close()
        } catch (error) {
          this.#sessions.set(delegate, session)
          throw error
        }
      }
      this.#delegates.delete(delegate)
    })
    this.#detaching.set(delegate, job)
    void job.then(
      () => this.#detaching.delete(delegate),
      () => this.#detaching.delete(delegate)
    )
    return job
  }

  delete<T>(delegate: DocumentDelegate<T>): Promise<void> {
    const existing = this.#deleting.get(delegate.id)
    if (existing) return existing
    if (this.#stopping) return Promise.reject(new Error("Scheduler is closed"))
    const affected = [...this.#delegates].filter(
      item => item.id === delegate.id
    )
    if (!affected.includes(delegate)) affected.push(delegate)
    const sessions: SedimentreeSession[] = []
    const tail = this.#tails.get(delegate.id)
    const detachments = [...this.#detaching]
      .filter(([item]) => item.id === delegate.id)
      .map(([, job]) => job)
    // Install the barrier before delete listeners can synchronously submit work.
    const job = Promise.resolve().then(async () => {
      const results = await Promise.allSettled(
        sessions.map(session => Promise.resolve().then(() => session.close()))
      )
      await Promise.allSettled([...(tail ? [tail] : []), ...detachments])
      this.#generations.set(
        delegate.id,
        (this.#generations.get(delegate.id) ?? 0) + 1
      )
      const errors = results
        .filter(result => result.status === "rejected")
        .map(result => result.reason)
      try {
        await this.backend.deleteLocal(delegate.id)
      } catch (error) {
        errors.push(error)
      }
      if (errors.length)
        throw new AggregateError(errors, "Document deletion failed")
    })
    this.#deleting.set(delegate.id, job)
    for (const item of affected) {
      try {
        item.markDeleted()
      } catch (error) {
        item.document.log.error("error notifying document deletion", error)
      }
      const session = this.#sessions.get(item)
      this.#sessions.delete(item)
      this.#delegates.delete(item)
      if (session) sessions.push(session)
    }
    void job.then(
      () => this.#deleting.delete(delegate.id),
      () => this.#deleting.delete(delegate.id)
    )
    return job
  }

  shutdown(): Promise<void> {
    if (this.#closing) return this.#closing
    this.#stopping = true
    for (const delegate of this.#delegates) delegate.close()
    const sessions = [...this.#sessions.values()]
    this.#sessions.clear()
    const tails = [...this.#tails.values()]
    const creations = [...this.#creating.keys()]
    const deletions = [...this.#deleting.values()]
    const detachments = [...this.#detaching.values()]
    this.#closing = (async () => {
      const results = await Promise.allSettled([
        ...tails,
        ...creations,
        ...deletions,
        ...detachments,
        ...sessions.map(session =>
          Promise.resolve().then(() => session.close())
        ),
        ...[...this.#delegates].map(delegate =>
          delegate.drain((id, source) => this.#submit(id, source, true))
        ),
      ])
      const errors = results
        .filter(result => result.status === "rejected")
        .map(result => result.reason)
      try {
        await this.backend.flush()
      } catch (error) {
        errors.push(error)
      }
      try {
        await this.backend.close()
      } catch (error) {
        errors.push(error)
      }
      await Promise.allSettled([...this.#consumers])
      this.#delegates.clear()
      if (errors.length)
        throw new AggregateError(errors, "Repo shutdown failed")
    })()
    return this.#closing
  }

  close(): Promise<void> {
    return this.shutdown()
  }
}
