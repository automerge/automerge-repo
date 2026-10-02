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
  DocumentQuery,
  progressAtHeads,
  progressAtPath,
  type DocumentProgress,
} from "./DocumentQuery.js"
import { makeLogger } from "./Logger.js"
import { RepoScheduler } from "./RepoScheduler.js"
import { extractRecords } from "./sedimentree/automerge/index.js"
import {
  BackendError,
  idBytes,
  sedimentreeId,
  type SedimentreeBackend,
  type SedimentreeId,
} from "./sedimentree/index.js"
import type { AnyDocumentId, BinaryDocumentId, DocumentId } from "./types.js"
import type { AbortOptions } from "./helpers/abortable.js"
import { isPlainObject } from "./helpers/isPlainObject.js"

export type { DocumentProgress } from "./DocumentQuery.js"
export type { SyncInfo } from "./DocHandle.js"

type Entry<T = any> = {
  document: Document<T>
  handle: DocHandle<T>
  query: DocumentQuery<T>
  delegate?: DocumentDelegate<T>
}

/** Owns Automerge documents; an optional backend owns their storage and sync. */
export class Repo extends EventEmitter<RepoEvents> {
  #log = makeLogger("automerge-repo:repo")
  #entries = new Map<DocumentId, Entry>()
  #scheduler?: RepoScheduler
  #operations = new Set<Promise<unknown>>()
  #deleting = new Map<DocumentId, Promise<void>>()
  #closed = false
  #shutdown?: Promise<void>
  #origin = { kind: "repo", id: crypto.randomUUID(), path: [] as string[] }

  constructor({ backend, flushConcurrency = 20 }: RepoConfig = {}) {
    super()
    if (backend)
      this.#scheduler = new RepoScheduler(backend, {
        concurrency: flushConcurrency,
      })
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

  /** @deprecated Use find(). A replacement query API is deferred. */
  findWithProgress<T>(
    id: AnyDocumentId,
    _options?: AbortOptions
  ): DocumentProgress<T> {
    this.#checkOpen()
    return this.#progress<T>(id)
  }

  /** Cancellation stops this wait, not the shared document's loading. */
  async find<T>(
    id: AnyDocumentId,
    options: RepoFindOptions = {}
  ): Promise<DocHandle<T>> {
    this.#checkOpen()
    options.signal?.throwIfAborted()
    return this.#progress<T>(id).whenReady(options)
  }

  #progress<T>(id: AnyDocumentId): DocumentProgress<T> {
    const parsed = isValidAutomergeUrl(id)
      ? parseAutomergeUrl(id)
      : {
          documentId: interpretAsDocumentId(id),
          heads: undefined,
          segments: undefined,
        }
    const { documentId, heads, segments } = parsed
    if (this.#deleting.has(documentId))
      throw new Error("Document deletion in progress")
    const entry = this.#entries.get(documentId) ?? this.#register(documentId)
    let progress: DocumentProgress<T> = entry.query
    if (heads) progress = progressAtHeads(entry.query, heads)
    if (segments?.length) progress = progressAtPath(progress, segments)
    return progress
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
    if (this.#deleting.has(id)) throw new Error("Document deletion in progress")
    const existing = this.#entries.get(id)
    if (existing?.query.peek().state === "ready") {
      await existing.handle.update(current => A.merge(current, A.clone(doc)))
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
      await handle.update(current => A.merge(current, A.clone(doc)))
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
    if (this.#scheduler) {
      const allocated = await this.#scheduler.create(
        extractRecords(doc),
        requested ? { documentId: this.#backendId(requested) } : undefined
      )
      id = binaryToDocumentId(idBytes(allocated) as BinaryDocumentId)
    } else {
      id = requested ?? this.#localId()
    }
    this.#checkOpen()
    if (this.#deleting.has(id)) throw new Error("Document deletion in progress")
    const existing = this.#entries.get(id)
    if (existing) {
      // Loading can begin while backend creation is pending. Adopt that shared entry.
      if (existing.document.deleted || existing.document.closed)
        throw new Error("Document is no longer open")
      if (existing.query.peek().state === "failed") {
        if (existing.delegate) await this.#scheduler!.detach(existing.delegate)
        this.#checkOpen()
        this.#entries.delete(id)
        return this.#register(id, doc).handle
      }
      if (existing.delegate) {
        existing.delegate.onEvent({
          type: "records",
          sequence: 0,
          phase: "initial",
          records: extractRecords(doc),
        })
        existing.delegate.attach(existing.handle, true)
      } else {
        await existing.document.applyMutation(
          current => A.merge(current, A.clone(doc)),
          { incoming: true }
        )
      }
      return existing.handle
    }
    return this.#register(id, doc).handle
  }

  #localId(): DocumentId {
    let bytes: Uint8Array
    let id: DocumentId
    do {
      bytes = crypto.getRandomValues(new Uint8Array(32))
      id = binaryToDocumentId(bytes as BinaryDocumentId)
    } while (
      bytes.subarray(16).every(byte => byte === 0) ||
      this.#entries.has(id)
    )
    return id
  }

  #backendId(id: DocumentId): SedimentreeId {
    const bytes = documentIdToBinary(id)
    if (!bytes) throw new TypeError("Invalid document ID")
    return sedimentreeId(bytes)
  }

  #register<T>(id: DocumentId, initial?: A.Doc<T>): Entry<T> {
    const document = new Document(id, initial ?? A.init<T>())
    const handle = new DocHandle(document)
    const query = new DocumentQuery(handle, new Map(), {
      initialSnapshotPending: !!this.#scheduler && !initial,
    })
    const entry: Entry<T> = { document, handle, query }
    if (this.#scheduler) {
      const scheduler = this.#scheduler
      let delegate!: DocumentDelegate<T>
      delegate = new DocumentDelegate(
        this.#backendId(id),
        document,
        query,
        (tree, records) => scheduler.submit(tree, records),
        () => scheduler.synchronize(delegate)
      )
      entry.delegate = delegate
      delegate.attach(handle, !!initial)
      handle.on("ephemeral-message-outbound", ({ data }) => {
        void scheduler
          .publishEphemeral(delegate, {
            messageId: crypto.randomUUID(),
            origin: this.#origin,
            payload: data,
          })
          .catch(error =>
            this.#log.error("ephemeral publication failed", error)
          )
      })
    }
    this.#entries.set(id, entry)
    if (entry.delegate) {
      try {
        this.#scheduler!.open(entry.delegate)
      } catch (error) {
        entry.delegate.fail(error)
      }
    }
    this.emit("document", { handle })
    query.subscribe(state => {
      if (
        state.state === "failed" &&
        document.deleted &&
        !this.#deleting.has(id) &&
        this.#entries.get(id) === entry
      ) {
        this.#entries.delete(id)
        this.emit("delete-document", { documentId: id })
      }
      if (state.state === "unavailable")
        this.emit("unavailable-document", { documentId: id })
    })
    return entry
  }

  async export(id: AnyDocumentId): Promise<Uint8Array | undefined> {
    const handle = await this.find(id)
    return A.save(handle.fullDoc())
  }

  delete(id: AnyDocumentId): Promise<void> {
    this.#checkOpen()
    const documentId = interpretAsDocumentId(id)
    const pending = this.#deleting.get(documentId)
    if (pending) return pending
    const entry = this.#entries.get(documentId) ?? this.#register(documentId)
    // Install the Repo barrier before handle delete listeners can reenter.
    let resolve!: () => void
    let reject!: (error: unknown) => void
    const barrier = new Promise<void>((yes, no) => {
      resolve = yes
      reject = no
    })
    const deleting = barrier.then(() => {
      if (this.#entries.get(documentId) === entry)
        this.#entries.delete(documentId)
      this.emit("delete-document", { documentId })
    })
    this.#deleting.set(documentId, deleting)
    void deleting.then(
      () => this.#deleting.delete(documentId),
      () => this.#deleting.delete(documentId)
    )
    void this.#track(deleting)
    try {
      // Submit before returning so shutdown cannot overtake an accepted deletion.
      if (entry.delegate)
        void this.#scheduler!.delete(entry.delegate).then(resolve, reject)
      else {
        entry.document.closed = true
        entry.handle.delete()
        entry.query.fail(new Error("Document deleted"))
        resolve()
      }
    } catch (error) {
      reject(error)
    }
    return deleting
  }

  /** Retry and drain accepted local history; reject after all targeted work settles. */
  flush(documents?: DocumentId[]): Promise<void> {
    this.#checkOpen()
    return (
      this.#scheduler?.flush(documents?.map(id => this.#backendId(id))) ??
      Promise.resolve()
    )
  }

  /** Persist first, then release a cached document without deleting its history. */
  async removeFromCache(id: DocumentId): Promise<void> {
    this.#checkOpen()
    const entry = this.#entries.get(id)
    if (!entry) return
    if (!entry.delegate)
      throw new Error(
        "Cannot evict a local-only document: its handle holds the only copy"
      )
    await this.#track(this.#scheduler!.detach(entry.delegate))
    if (this.#entries.get(id) === entry) this.#entries.delete(id)
    entry.query.fail(new Error("Document removed from cache"))
  }

  /** Best-effort teardown. Use flush() first when persistence failures must reject. */
  shutdown(): Promise<void> {
    if (this.#shutdown) return this.#shutdown
    this.#closed = true
    for (const entry of this.#entries.values()) entry.document.closed = true
    const operations = [...this.#operations]
    // Install the promise before notifying subscribers that may reenter shutdown.
    this.#shutdown = Promise.resolve().then(async () => {
      for (const entry of this.#entries.values())
        entry.query.fail(new Error("Repo is shut down"))
      const results = await Promise.allSettled([
        ...operations,
        this.#scheduler?.shutdown() ?? Promise.resolve(),
      ])
      for (const result of results)
        if (result.status === "rejected")
          this.#log.error("error during Repo shutdown", result.reason)
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

export interface RepoConfig {
  backend?: SedimentreeBackend
  /** Maximum concurrent local backend operations across documents. Defaults to 20. */
  flushConcurrency?: number
}

export type RepoFindOptions = AbortOptions
export type DeleteDocumentPayload = { documentId: DocumentId }
export type DocumentPayload = { handle: DocHandle<any> }
export type DocMetrics = {
  type: string
  documentId: DocumentId
  [key: string]: unknown
}
export interface RepoEvents {
  document: (payload: DocumentPayload) => void
  "delete-document": (payload: DeleteDocumentPayload) => void
  "unavailable-document": (payload: DeleteDocumentPayload) => void
  "doc-metrics": (payload: DocMetrics) => void
}
