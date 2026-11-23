import { next as A } from "@automerge/automerge/slim"
import { EventEmitter } from "eventemitter3"
import {
  binaryToDocumentId,
  documentIdToBinary,
  interpretAsDocumentId,
  isValidDocumentUrl,
  parseDocumentUrl,
} from "./AutomergeUrl.js"
import {
  requireView,
  type AnyDocType,
  type InitOf,
  type Of,
} from "./DocType.js"
import { extendHandle } from "./DocHandle.js"
import { Handle } from "./Handle.js"
import { isHandleOf, type DocHandle } from "./types/DocHandle.js"
import { Document } from "./Document.js"
import {
  queryAtHeads,
  queryAtPath,
  waitUntilReady,
  type DocumentQuery,
} from "./DocumentQuery.js"
import { toProgress, type DocumentProgress } from "./DocumentProgress.js"
import { makeLogger } from "./Logger.js"
import { automerge, type AutomergeDocType } from "./automerge/docType.js"
import { MemoryBackend } from "./sedimentree/memory/MemoryBackend.js"
import {
  BackendError,
  idBytes,
  sedimentreeId,
  type HandleExtensionSpec,
  type SedimentreeBackend,
  type SedimentreeId,
} from "./sedimentree/index.js"
import type {
  AnyDocumentId,
  BinaryDocumentId,
  DocumentId,
  RepoId,
} from "./types.js"

/**
 * Owns Automerge documents; its backend owns their storage and sync. `X` is
 * what the backend's extensions add to every handle; it is taken from the
 * backend's type, see {@link SedimentreeBackend}.
 */
export class Repo<X extends HandleExtensionSpec = {}> extends EventEmitter<
  RepoEvents<X>
> {
  #log = makeLogger("automerge-repo:repo")
  #documents = new Map<DocumentId, Document<any>>()
  #backend: SedimentreeBackend
  #operations = new Set<Promise<unknown>>()
  #closed = false
  #shutdown?: Promise<void>
  #id: RepoId
  /** The handle class for each doc type: its members and the backend's extensions. */
  #classes = new Map<AnyDocType, typeof Handle>()

  constructor({
    backend,
    id = crypto.randomUUID() as RepoId,
  }: RepoConfig<X> = {}) {
    super()
    if (typeof id !== "string" || !id)
      throw new TypeError("id must be a nonempty string")
    this.#backend = backend ?? new MemoryBackend()
    this.#id = id
    // Built now so an extension clash with Automerge's API throws here.
    this.#classFor(automerge)
  }

  #classFor(type: AnyDocType): typeof Handle {
    let Class = this.#classes.get(type)
    if (!Class) {
      Class = extendHandle(
        this.#backend.handleExtensions ?? [],
        (type.handle ?? Handle) as typeof Handle
      )
      this.#classes.set(type, Class)
    }
    return Class
  }

  /** This Repo instance's identity; see {@link RepoConfig.id}. */
  get id(): RepoId {
    return this.#id
  }

  /** Every open document's root handle, whatever its type. */
  get handles(): Record<DocumentId, DocHandle<any, X, AnyDocType>> {
    return Object.fromEntries(
      [...this.#documents].map(([id, document]) => [id, document.handle])
    ) as unknown as Record<DocumentId, DocHandle<any, X, AnyDocType>>
  }

  /** A document of the doc type `type`. */
  // `_T` lets `repo.create<T>` instantiate every overload; the last one,
  // Automerge's, is what `ReturnType` reads.
  create<_T = unknown, D extends AnyDocType = AnyDocType, S = unknown>(
    initialValue: InitOf<D, S>,
    options: { type: Of<D, S> }
  ): Promise<DocHandle<S, X, D>>
  /** Resolve after initial history is locally recoverable, without waiting for peers. */
  create<T>(initialValue?: T): Promise<DocHandle<T, X>>
  async create(
    initialValue?: unknown,
    { type = automerge }: { type?: AnyDocType } = {}
  ): Promise<DocHandle<any, X, any>> {
    this.#checkOpen()
    const state = type.create(initialValue, { repoId: this.#id })
    return this.#track(this.#createDocument(state, undefined, type))
  }

  async clone<T>(handle: DocHandle<T>): Promise<DocHandle<T, X>> {
    this.#checkOpen()
    if (!isHandleOf(handle, automerge))
      throw new Error("Only Automerge documents can be cloned")
    return this.#track(this.#createDocument(A.clone(handle.fullDoc())))
  }

  /**
   * @deprecated Use {@link Repo.query} to observe loading, or
   * {@link Repo.find} to await it.
   */
  findWithProgress<
    _T = unknown,
    D extends AnyDocType = AnyDocType,
    S = unknown,
  >(
    id: AnyDocumentId,
    options: AbortOptions & { type: Of<D, S> }
  ): DocumentProgress<S, X, D>
  findWithProgress<T>(
    id: AnyDocumentId,
    options?: AbortOptions
  ): DocumentProgress<T, X>
  findWithProgress(
    id: AnyDocumentId,
    options: AbortOptions & { type?: AnyDocType } = {}
  ): DocumentProgress<any, X, any> {
    return toProgress(this.query(id, options as { type: AnyDocType }))
  }

  /** A document of the doc type `type`; its URL must have `type`'s scheme. */
  find<_T = unknown, D extends AnyDocType = AnyDocType, S = unknown>(
    id: AnyDocumentId,
    options: RepoFindOptions & { type: Of<D, S> }
  ): Promise<DocHandle<S, X, D>>
  /** Cancellation stops this wait, not the shared document's loading. */
  find<T>(
    id: AnyDocumentId,
    options?: RepoFindOptions
  ): Promise<DocHandle<T, X>>
  async find(
    id: AnyDocumentId,
    options: RepoFindOptions & { type?: AnyDocType } = {}
  ): Promise<DocHandle<any, X, any>> {
    options.signal?.throwIfAborted()
    return waitUntilReady(
      this.query(id, options as { type: AnyDocType }),
      options.signal
    )
  }

  /**
   * Observe the readiness of a document, starting to load it if needed.
   * Accepts everything {@link Repo.find} does; heads and paths in a URL
   * yield the matching view or sub-handle once ready.
   */
  /** A document of the doc type `type`; its URL must have `type`'s scheme. */
  query<_T = unknown, D extends AnyDocType = AnyDocType, S = unknown>(
    id: AnyDocumentId,
    options: { type: Of<D, S> }
  ): DocumentQuery<S, X, D>
  query<T>(id: AnyDocumentId): DocumentQuery<T, X>
  query(
    id: AnyDocumentId,
    { type = automerge }: { type?: AnyDocType } = {}
  ): DocumentQuery<any, X, any> {
    this.#checkOpen()
    const parsed = isValidDocumentUrl(id)
      ? parseDocumentUrl(id)
      : {
          documentId: interpretAsDocumentId(id),
          heads: undefined,
          segments: undefined,
          scheme: undefined,
        }
    const { documentId, heads, segments, scheme } = parsed
    if (scheme !== undefined && scheme !== type.scheme)
      throw new Error(
        type === automerge
          ? `Cannot open ${id}: its URL scheme requires a matching document type`
          : `Cannot open ${id} as ${type.scheme}: its URL scheme is ${scheme}`
      )
    const existing = this.#documents.get(documentId)
    if (existing && existing.type.scheme !== type.scheme)
      throw new Error(
        `Document ${documentId} is already open as ${existing.type.scheme}, not ${type.scheme}`
      )
    const document = existing ?? this.#register(documentId, undefined, type)
    let query = document.query as DocumentQuery<any, X, any>
    if (heads) {
      requireView(type)
      query = queryAtHeads(query, heads, fn =>
        document.state.onHeadsChanged(fn)
      )
    }
    if (segments?.length) {
      if (type !== automerge)
        throw new Error(`${type.scheme} URLs have no paths: ${id}`)
      query = queryAtPath(query, segments)
    }
    return query
  }

  /** Import preserves history, including when the supplied ID is only stored on disk. */
  async import<T>(
    binary: Uint8Array,
    args?: { docId?: DocumentId }
  ): Promise<DocHandle<T, X>> {
    this.#checkOpen()
    const doc = A.load<T>(binary)
    const id = args?.docId && interpretAsDocumentId(args.docId)
    return this.#track(this.#importDocument(doc, id))
  }

  async #importDocument<T>(
    doc: A.Doc<T>,
    id?: DocumentId
  ): Promise<DocHandle<T, X>> {
    if (!id) return this.#createDocument(doc)
    const existing = this.#documents.get(id)
    if (existing && existing.type !== automerge)
      throw new Error(`Document ${id} is not an Automerge document`)
    if (existing?.query.state().status === "ready") {
      await existing.state.applyMutation(
        current => A.merge(current, A.clone(doc)),
        { compact: true }
      )
      this.#checkOpen()
      return this.#handle(existing)
    }
    try {
      return await this.#createDocument(doc, id)
    } catch (error) {
      // A creation conflict means stored history exists, not that import should replace it.
      if (!(error instanceof BackendError && error.code === "conflict"))
        throw error
      const handle = await this.find<T>(id)
      await this.#documents
        .get(id)!
        .state.applyMutation(current => A.merge(current, A.clone(doc)), {
          compact: true,
        })
      this.#checkOpen()
      return handle
    }
  }

  async #createDocument<T>(
    doc: A.Doc<T>,
    requested?: DocumentId,
    type: AnyDocType = automerge
  ): Promise<DocHandle<T, X>> {
    if (!type.heads(doc).length) {
      if (type !== automerge)
        throw new Error(`A new ${type.scheme} document needs a commit`)
      doc = A.emptyChange(doc)
    }
    const allocated = await this.#backend.create(
      type.recordsSince(doc, []),
      requested ? { documentId: this.#backendId(requested) } : undefined
    )
    const id = binaryToDocumentId(idBytes(allocated) as BinaryDocumentId)
    this.#checkOpen()
    const existing = this.#documents.get(id)
    if (existing) {
      // Loading can begin while backend creation is pending. Adopt that shared entry.
      if (existing.state.deleted || existing.state.closed)
        throw new Error("Document is no longer open")
      if (existing.type.scheme !== type.scheme)
        throw new Error(
          `Document ${id} is already open as ${existing.type.scheme}, not ${type.scheme}`
        )
      existing.adopt(doc)
      return this.#handle(existing)
    }
    return this.#handle(this.#register<T>(id, doc, type))
  }

  /** The root handle, typed with the backend's extensions. */
  #handle<T>(document: Document<T>): DocHandle<T, X> {
    return document.handle as DocHandle<T, X>
  }

  #backendId(id: DocumentId): SedimentreeId {
    const bytes = documentIdToBinary(id)
    if (!bytes) throw new TypeError("Invalid document ID")
    return sedimentreeId(bytes)
  }

  #register<T>(
    id: DocumentId,
    initial?: A.Doc<T>,
    type: AnyDocType = automerge
  ): Document<T> {
    const document = new Document<T>(
      this.#backendId(id),
      id,
      this.#backend,
      this.#id,
      initial,
      this.#classFor(type),
      type
    )
    const handle = this.#handle(document)
    this.#documents.set(id, document)
    let announced = false
    document.start()
    document.query.subscribe(state => {
      if (!announced && state.status === "ready") {
        announced = true
        this.emit("document", { handle })
      }
      if (state.status === "unavailable")
        this.emit("unavailable-document", { documentId: id })
      if (
        (state.status !== "deleted" && state.status !== "failed") ||
        this.#documents.get(id) !== document
      )
        return
      // A settled query is final; a later lookup starts a fresh document.
      this.#documents.delete(id)
      // Shutdown releases sessions itself.
      if (this.#closed) return
      void this.#track(document.release()).catch(error =>
        this.#log.error("failed to release a settled document", error)
      )
      if (state.status === "deleted")
        this.emit("delete-document", { documentId: id })
    })
    return document
  }

  async export(id: AnyDocumentId): Promise<Uint8Array | undefined> {
    const handle = await this.find(id)
    if (!isHandleOf(handle, automerge))
      throw new Error("Only Automerge documents can be exported")
    return A.save(handle.fullDoc())
  }

  /** Concurrent calls are not deduplicated; each resolves once history is
   * removed and emits `delete-document`. */
  delete(id: AnyDocumentId): Promise<void> {
    this.#checkOpen()
    const documentId = interpretAsDocumentId(id)
    const document = this.#documents.get(documentId)
    // A settled document's subscriber ignores it once it leaves the map, so it
    // neither releases the session nor emits; this call does both.
    this.#documents.delete(documentId)
    // The backend fences the ID synchronously, so reentrant delete listeners
    // cannot reacquire it; it drains earlier stores before removal. Then stop
    // our own producer and release the session.
    let removal: Promise<void>
    try {
      removal = this.#backend.deleteLocal(this.#backendId(documentId))
    } catch (error) {
      removal = Promise.reject(error)
    }
    const release = (async () => {
      document?.markDeleted()
      await document?.release()
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
      const targets = documents
        ? documents.flatMap(id => this.#documents.get(id) ?? [])
        : [...this.#documents.values()]
      return this.#track(
        (async () => {
          // Compactions submit their stores synchronously, so the barrier
          // captured next covers them; a queued rerun is awaited directly.
          const compactions = targets.map(document => document.compactNow())
          const barrier = backend.flush(
            documents?.map(id => this.#backendId(id))
          )
          const results = await Promise.allSettled([...compactions, barrier])
          const errors = new Set(
            collectErrors(results).flatMap(error =>
              error instanceof AggregateError ? error.errors : [error]
            )
          )
          for (const document of targets) {
            const failure = document.state.writeFailure
            if (failure && !document.state.deleted) errors.add(failure.error)
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
    const document = this.#documents.get(id)
    if (!document) return
    // Stop edits before draining; otherwise retained handles can outlive eviction.
    document.close()
    await this.flush([id])
    await this.#track(document.release())
    if (this.#documents.get(id) === document) this.#documents.delete(id)
    document.query.fail(new Error("Document removed from cache"))
  }

  /** Best-effort teardown. Use flush() first when persistence failures must reject. */
  shutdown(): Promise<void> {
    if (this.#shutdown) return this.#shutdown
    this.#closed = true
    const documents = [...this.#documents.values()]
    for (const document of documents) document.close()
    const operations = [...this.#operations]
    const backend = this.#backend
    // Install the promise before notifying subscribers that may reenter shutdown.
    this.#shutdown = Promise.resolve().then(async () => {
      for (const document of documents)
        document.query.fail(new Error("Repo is shut down"))
      const results = await Promise.allSettled(operations)
      results.push(
        ...(await Promise.allSettled(
          documents.map(document => document.compactNow())
        ))
      )
      results.push(...(await Promise.allSettled([backend.flush()])))
      results.push(...(await Promise.allSettled([backend.close()])))
      await Promise.allSettled(documents.map(document => document.settled()))
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
        [...this.#documents].map(([id, document]) => [
          id,
          document.handle.metrics(),
        ])
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

/**
 * The handle a Repo of type `R` gives for documents of type `T`: with the
 * extensions of `R`'s backend. Lets an app name its handles from its Repo:
 * `type AppHandle<T> = HandleOf<typeof repo, T>`.
 */
export type HandleOf<
  R extends Repo,
  T,
  D extends AnyDocType = AutomergeDocType,
> = R extends Repo<infer X> ? DocHandle<T, X, D> : DocHandle<T, {}, D>

export interface RepoConfig<X extends HandleExtensionSpec = {}> {
  /**
   * Owns storage and synchronization; closed by {@link Repo.shutdown}.
   * Defaults to a {@link MemoryBackend}: no persistence and no peers.
   */
  backend?: SedimentreeBackend<X>
  /**
   * Identifies this Repo instance; a random UUID by default. Must be unique
   * among concurrently live Repos: backend features (e.g. ephemeral
   * messaging) use it to tell Repos behind one peer apart. Not verified by
   * receivers.
   */
  id?: RepoId
}

/** Include in an options object to pass an AbortSignal to a function. */
export interface AbortOptions {
  signal?: AbortSignal
}

export type RepoFindOptions = AbortOptions
export type DeleteDocumentPayload = { documentId: DocumentId }
export type DocumentPayload<X extends HandleExtensionSpec = {}> = {
  /** The root handle of a document of any type. */
  handle: DocHandle<any, X, AnyDocType>
}
export interface RepoEvents<X extends HandleExtensionSpec = {}> {
  document: (payload: DocumentPayload<X>) => void
  "delete-document": (payload: DeleteDocumentPayload) => void
  "unavailable-document": (payload: DeleteDocumentPayload) => void
}
