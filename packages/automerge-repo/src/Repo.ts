import { next as A } from "@automerge/automerge/slim"
import { EventEmitter } from "eventemitter3"
import {
  binaryToDocumentId,
  documentIdToBinary,
  interpretAsDocumentId,
  isValidAutomergeUrl,
  parseAutomergeUrl,
} from "./AutomergeUrl.js"
import { DocHandle } from "./DocHandle.js"
import { Document } from "./Document.js"
import { DocumentDelegate } from "./DocumentDelegate.js"
import {
  RootQuery,
  queryAtHeads,
  queryAtPath,
  waitUntilReady,
  type DocumentQuery,
} from "./DocumentQuery.js"
import { toProgress, type DocumentProgress } from "./DocumentProgress.js"
import { makeLogger } from "./Logger.js"
import { extractRecords } from "./sedimentree/automerge/index.js"
import {
  BackendError,
  idBytes,
  mintBackendId,
  sedimentreeId,
  type MintDocumentId,
  type BackendIdentity,
  type SedimentreeBackend,
  type SedimentreeId,
} from "./sedimentree/index.js"
import type {
  AnyDocumentId,
  BinaryDocumentId,
  DocumentId,
  RepoId,
} from "./types.js"
import { isPlainObject } from "./helpers/isPlainObject.js"

type Entry<T = any> = {
  document: Document<T>
  handle: DocHandle<T>
  query: RootQuery<T>
  delegate?: DocumentDelegate<T>
}

/** Owns Automerge documents; an optional backend owns their storage and sync. */
export class Repo extends EventEmitter<RepoEvents> {
  #log = makeLogger("automerge-repo:repo")
  #entries = new Map<DocumentId, Entry>()
  #backend?: SedimentreeBackend
  #mintDocumentId?: MintDocumentId
  #operations = new Set<Promise<unknown>>()
  #closed = false
  #shutdown?: Promise<void>
  /**
   * This Repo's identity on the backend contract, e.g. as the origin of its
   * ephemerals.
   */
  #identity: BackendIdentity

  constructor({
    backend,
    mintDocumentId,
    id = crypto.randomUUID() as RepoId,
  }: RepoConfig = {}) {
    super()
    if (typeof id !== "string" || !id)
      throw new TypeError("id must be a nonempty string")
    this.#backend = backend
    this.#mintDocumentId = mintDocumentId
    this.#identity = Object.freeze({
      kind: "repo",
      id,
      path: Object.freeze([]),
    })
  }

  /** This Repo instance's identity; see {@link RepoConfig.id}. */
  get id(): RepoId {
    return this.#identity.id as RepoId
  }

  get handles(): Record<DocumentId, DocHandle<any>> {
    return Object.fromEntries(
      [...this.#entries].map(([id, entry]) => [id, entry.handle])
    ) as Record<DocumentId, DocHandle<any>>
  }

  /** Resolve after initial history is locally recoverable, without waiting for peers. */
  async create<T>(initialValue?: T): Promise<DocHandle<T>> {
    this.#checkOpen()
    const doc =
      isPlainObject(initialValue) && Object.keys(initialValue).length
        ? (A.from(initialValue) as A.Doc<T>)
        : A.emptyChange(A.init<T>())
    return this.#track(this.#createDocument(doc))
  }

  async clone<T>(handle: DocHandle<T>): Promise<DocHandle<T>> {
    this.#checkOpen()
    return this.#track(this.#createDocument(A.clone(handle.fullDoc())))
  }

  /**
   * @deprecated Use {@link Repo.query} to observe loading, or
   * {@link Repo.find} to await it.
   */
  findWithProgress<T>(
    id: AnyDocumentId,
    _options?: AbortOptions
  ): DocumentProgress<T> {
    return toProgress(this.query<T>(id))
  }

  /** Cancellation stops this wait, not the shared document's loading. */
  async find<T>(
    id: AnyDocumentId,
    options: RepoFindOptions = {}
  ): Promise<DocHandle<T>> {
    options.signal?.throwIfAborted()
    return waitUntilReady(this.query<T>(id), options.signal)
  }

  /**
   * Observe the readiness of a document, starting to load it if needed.
   * Accepts everything {@link Repo.find} does; heads and paths in a URL
   * yield the matching view or sub-handle once ready.
   */
  query<T>(id: AnyDocumentId): DocumentQuery<T> {
    this.#checkOpen()
    const parsed = isValidAutomergeUrl(id)
      ? parseAutomergeUrl(id)
      : {
          documentId: interpretAsDocumentId(id),
          heads: undefined,
          segments: undefined,
        }
    const { documentId, heads, segments } = parsed
    const entry: Entry<T> =
      this.#entries.get(documentId) ?? this.#register<T>(documentId)
    let query: DocumentQuery<T> = entry.query
    if (heads) query = queryAtHeads(query, heads)
    if (segments?.length) query = queryAtPath(query, segments)
    return query
  }

  /** Import preserves history, including when the supplied ID is only stored on disk. */
  async import<T>(
    binary: Uint8Array,
    args?: { docId?: DocumentId }
  ): Promise<DocHandle<T>> {
    this.#checkOpen()
    const doc = A.load<T>(binary)
    const id = args?.docId && interpretAsDocumentId(args.docId)
    return this.#track(this.#importDocument(doc, id))
  }

  async #importDocument<T>(
    doc: A.Doc<T>,
    id?: DocumentId
  ): Promise<DocHandle<T>> {
    if (!id) return this.#createDocument(doc)
    const existing = this.#entries.get(id)
    if (existing?.query.state().status === "ready") {
      await existing.document.applyMutation(
        current => A.merge(current, A.clone(doc)),
        { compact: true }
      )
      this.#checkOpen()
      return existing.handle
    }
    try {
      return await this.#createDocument(doc, id)
    } catch (error) {
      // A creation conflict means stored history exists, not that import should replace it.
      if (!(error instanceof BackendError && error.code === "conflict"))
        throw error
      const handle = await this.find<T>(id)
      await this.#entries
        .get(id)!
        .document.applyMutation(current => A.merge(current, A.clone(doc)), {
          compact: true,
        })
      this.#checkOpen()
      return handle
    }
  }

  async #createDocument<T>(
    doc: A.Doc<T>,
    requested?: DocumentId
  ): Promise<DocHandle<T>> {
    if (!A.getHeads(doc).length) doc = A.emptyChange(doc)
    let id: DocumentId
    if (this.#backend) {
      const records = extractRecords(doc)
      // Repo's minter overrides the backend's.
      const documentId = requested
        ? this.#backendId(requested)
        : this.#mintDocumentId &&
          (await mintBackendId(records, this.#mintDocumentId))
      const allocated = await this.#backend.create(
        records,
        documentId ? { documentId } : undefined
      )
      id = binaryToDocumentId(idBytes(allocated) as BinaryDocumentId)
    } else if (requested) {
      id = requested
    } else {
      const minted = await mintBackendId(
        this.#mintDocumentId ? extractRecords(doc) : [],
        this.#mintDocumentId
      )
      id = binaryToDocumentId(idBytes(minted) as BinaryDocumentId)
      if (this.#entries.has(id))
        throw new BackendError("create", "conflict", "Document already exists")
    }
    this.#checkOpen()
    const existing = this.#entries.get(id)
    if (existing) {
      // Loading can begin while backend creation is pending. Adopt that shared entry.
      if (existing.document.deleted || existing.document.closed)
        throw new Error("Document is no longer open")
      if (existing.delegate) existing.delegate.adopt(doc)
      else {
        await existing.document.applyMutation(
          current => A.merge(current, A.clone(doc)),
          { incoming: true }
        )
        existing.query.ready()
      }
      return existing.handle
    }
    return this.#register<T>(id, doc).handle
  }

  #backendId(id: DocumentId): SedimentreeId {
    const bytes = documentIdToBinary(id)
    if (!bytes) throw new TypeError("Invalid document ID")
    return sedimentreeId(bytes)
  }

  #register<T>(id: DocumentId, initial?: A.Doc<T>): Entry<T> {
    const document = new Document<T>(id, initial)
    const handle = new DocHandle(document)
    const query = new RootQuery(handle)
    document.query = query
    if (!this.#backend) {
      if (initial) query.ready()
      else query.unavailable()
    }
    const entry: Entry<T> = { document, handle, query }
    if (this.#backend)
      entry.delegate = new DocumentDelegate(
        this.#backendId(id),
        document,
        query,
        this.#backend,
        this.#identity,
        !!initial
      )
    this.#entries.set(id, entry)
    let announced = false
    entry.delegate?.start()
    query.subscribe(state => {
      if (!announced && state.status === "ready") {
        announced = true
        this.emit("document", { handle })
      }
      if (state.status === "unavailable")
        this.emit("unavailable-document", { documentId: id })
      if (
        (state.status !== "deleted" && state.status !== "failed") ||
        this.#entries.get(id) !== entry
      )
        return
      // A settled query is final; a later lookup starts a fresh entry.
      this.#entries.delete(id)
      // Shutdown releases sessions itself.
      if (this.#closed) return
      if (entry.delegate)
        void this.#track(entry.delegate.release()).catch(error =>
          this.#log.error("failed to release a settled document", error)
        )
      if (state.status === "deleted")
        this.emit("delete-document", { documentId: id })
    })
    return entry
  }

  async export(id: AnyDocumentId): Promise<Uint8Array | undefined> {
    const handle = await this.find(id)
    return A.save(handle.fullDoc())
  }

  /** Concurrent calls are not deduplicated; each resolves once history is
   * removed and emits `delete-document`. */
  delete(id: AnyDocumentId): Promise<void> {
    this.#checkOpen()
    const documentId = interpretAsDocumentId(id)
    const entry = this.#entries.get(documentId)
    // A settled entry's subscriber ignores it once it leaves the map, so it
    // neither releases the session nor emits; this call does both.
    this.#entries.delete(documentId)
    if (!this.#backend) {
      // Without a backend an unopened ID has no history to delete.
      if (!entry) return Promise.resolve()
      entry.document.close()
      entry.document.delete()
      this.emit("delete-document", { documentId })
      return Promise.resolve()
    }
    // The backend fences the ID synchronously, so reentrant delete listeners
    // cannot reacquire it; it drains earlier stores before removal. Then stop
    // our own producer and release the session.
    let removal: Promise<void>
    try {
      removal = this.#backend.deleteLocal(this.#backendId(documentId))
    } catch (error) {
      removal = Promise.reject(error)
    }
    const delegate = entry?.delegate
    const release = (async () => {
      delegate?.markDeleted()
      await delegate?.release()
    })()
    return this.#track(
      (async () => {
        const errors = collectErrors(
          await Promise.allSettled([release, removal])
        )
        if (errors.length)
          throw new AggregateError(errors, "Document deletion failed")
        this.emit("delete-document", { documentId })
      })()
    )
  }

  /**
   * The backend's persistence barrier: drain accepted local history and reject
   * after it settles whenever a targeted document has ever failed to store.
   * Due compactions run first, so their fragments are inside the barrier.
   * The backend reports failures of the stores it drained; each document keeps
   * its own first failure. Failed writes are not retried. Does not wait for
   * network delivery.
   */
  flush(ids?: DocumentId[]): Promise<void> {
    try {
      this.#checkOpen()
      const documents = ids?.map(interpretAsDocumentId)
      const backend = this.#backend
      if (!backend) return Promise.resolve()
      const targets = documents
        ? documents.flatMap(id => this.#entries.get(id) ?? [])
        : [...this.#entries.values()]
      return this.#track(
        (async () => {
          // Compactions submit their stores synchronously, so the barrier
          // captured next covers them; a queued rerun is awaited directly.
          const compactions = targets.map(entry => entry.delegate?.compactNow())
          const barrier = backend.flush(
            documents?.map(id => this.#backendId(id))
          )
          const results = await Promise.allSettled([...compactions, barrier])
          const errors = new Set(
            collectErrors(results).flatMap(error =>
              error instanceof AggregateError ? error.errors : [error]
            )
          )
          for (const entry of targets) {
            const failure = entry.document.writeFailure
            if (failure && !entry.document.deleted) errors.add(failure.error)
          }
          if (errors.size)
            throw new AggregateError([...errors], "Repo flush failed")
        })()
      )
    } catch (error) {
      return Promise.reject(error)
    }
  }

  /** Persist first, then release a cached document without deleting its history. */
  async removeFromCache(input: DocumentId): Promise<void> {
    this.#checkOpen()
    const id = interpretAsDocumentId(input)
    const entry = this.#entries.get(id)
    if (!entry) return
    const delegate = entry.delegate
    if (!delegate)
      throw new Error(
        "Cannot evict a local-only document: its handle holds the only copy"
      )
    // Stop edits before draining; otherwise retained handles can outlive eviction.
    delegate.close()
    await this.flush([id])
    await this.#track(delegate.release())
    if (this.#entries.get(id) === entry) this.#entries.delete(id)
    entry.query.fail(new Error("Document removed from cache"))
  }

  /** Best-effort teardown. Use flush() first when persistence failures must reject. */
  shutdown(): Promise<void> {
    if (this.#shutdown) return this.#shutdown
    this.#closed = true
    const entries = [...this.#entries.values()]
    for (const entry of entries) {
      if (entry.delegate) entry.delegate.close()
      else entry.document.close()
    }
    const operations = [...this.#operations]
    const backend = this.#backend
    // Install the promise before notifying subscribers that may reenter shutdown.
    this.#shutdown = Promise.resolve().then(async () => {
      for (const entry of entries)
        entry.query.fail(new Error("Repo is shut down"))
      const results = await Promise.allSettled(operations)
      if (backend) {
        results.push(
          ...(await Promise.allSettled(
            entries.map(entry => entry.delegate?.compactNow())
          ))
        )
        results.push(...(await Promise.allSettled([backend.flush()])))
        results.push(...(await Promise.allSettled([backend.close()])))
        await Promise.allSettled(
          entries.map(entry => entry.delegate?.settled())
        )
      }
      for (const error of collectErrors(results))
        this.#log.error("error during Repo shutdown", error)
    })
    return this.#shutdown
  }

  metrics(): {
    documents: Record<string, { numOps: number; numChanges: number }>
  } {
    return {
      documents: Object.fromEntries(
        [...this.#entries].map(([id, entry]) => [id, entry.handle.metrics()])
      ),
    }
  }

  #track<T>(operation: Promise<T>): Promise<T> {
    this.#operations.add(operation)
    void operation.then(
      () => this.#operations.delete(operation),
      () => this.#operations.delete(operation)
    )
    return operation
  }

  #checkOpen(): void {
    if (this.#closed) throw new Error("Repo is shut down")
  }
}

function collectErrors(results: PromiseSettledResult<unknown>[]): unknown[] {
  return results.flatMap(result =>
    result.status === "rejected" ? [result.reason] : []
  )
}

export interface RepoConfig {
  backend?: SedimentreeBackend
  /**
   * Mints the 32-byte ID of each new document, overriding the backend's own
   * minter; defaults to {@link mintDocumentId}.
   */
  mintDocumentId?: MintDocumentId
  /**
   * Identifies this Repo instance; a random UUID by default. Must be unique
   * among concurrently live Repos: it is the `originId` of the ephemeral
   * messages this Repo publishes, which tells Repos behind one peer apart, and
   * a Repo ignores messages from its own `id`. Not verified by receivers.
   */
  id?: RepoId
}

/** Include in an options object to pass an AbortSignal to a function. */
export interface AbortOptions {
  signal?: AbortSignal
}

export type RepoFindOptions = AbortOptions
export type DeleteDocumentPayload = { documentId: DocumentId }
export type DocumentPayload = { handle: DocHandle<any> }
export interface RepoEvents {
  document: (payload: DocumentPayload) => void
  "delete-document": (payload: DeleteDocumentPayload) => void
  "unavailable-document": (payload: DeleteDocumentPayload) => void
}
