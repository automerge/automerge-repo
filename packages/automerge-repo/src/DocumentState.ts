import { next as A } from "@automerge/automerge/slim"
import { makeLogger, Logger } from "./Logger.js"
import { decodeHeads, encodeHeads } from "./AutomergeUrl.js"
import type { DocumentId, PeerId, SyncInfo, UrlHeads } from "./types.js"
import { HandleRegistry } from "./subdoc-handles/handle-registry.js"
import { WeakValueMap } from "./helpers/WeakValueMap.js"
import { arraysAreEqual } from "./sedimentree/arraysAreEqual.js"
import { DocHandle } from "./DocHandle.js"
import { RootQuery } from "./DocumentQuery.js"
import type { Document } from "./Document.js"

/** What a {@link DocumentState} asks of the {@link Document} that owns it. */
type Owner = Pick<Document<any>, "commit" | "publishEphemeral">

/**
 * Per-document shared state - one per `documentId`, referenced by every
 * `DocHandle` (root, sub, view) into that document. Owns the Automerge
 * snapshot, the root handle, its readiness query and the
 * {@link HandleRegistry} (identity, pattern resolution, listeners, dispatch).
 * Local edits and ephemeral messages go out through its owning
 * {@link Document}. Not part of the public API.
 *
 * @internal
 */
export class DocumentState<T = unknown> {
  readonly documentId: DocumentId
  readonly registry: HandleRegistry
  readonly log: Logger
  /** The root handle Repo hands out. */
  readonly handle: DocHandle<T>
  /** Owns readiness. */
  readonly query: RootQuery<T>
  readonly #owner: Owner

  /** No WASM document until storage, peer history, or a caller needs one. */
  #doc?: A.Doc<T>

  /** Set by {@link DocumentState.delete}. */
  deleted = false
  #closed = false
  /** The first failed local write; once set, local edits are rejected. */
  writeFailure?: { error: unknown }

  #syncInfo = new Map<PeerId, SyncInfo>()
  /** Peers whose reports arrived before ready; their latest is in `#syncInfo`. */
  #pendingRemoteHeads = new Set<PeerId>()

  #events: (() => void)[] = []
  #dispatching = false

  /**
   * Materialized `A.view`s, keyed by heads. Heads precisely specify an
   * immutable state, so a view never changes once computed and the cache
   * never needs invalidating - the live doc only ever grows past these
   * heads, and `A.view` at a historical point is identical regardless.
   *
   * Held weakly: heads keys are unbounded over a document's life. A view
   * stays cached while held and is recomputed on a cold read.
   */
  #viewCache = new WeakValueMap<string, A.Doc<T>>()

  /** The owner is only stored here, not called, so it may still be constructing. */
  constructor(documentId: DocumentId, owner: Owner, initialDoc?: A.Doc<T>) {
    this.documentId = documentId
    this.#owner = owner
    this.#doc = initialDoc
    this.registry = new HandleRegistry(this)
    this.log = makeLogger(`automerge-repo:doc:${documentId.slice(0, 5)}`)
    this.handle = new DocHandle(this)
    this.query = new RootQuery(this.handle)
  }

  /** Best-effort; failures are logged by the owner, never rejected. */
  publishEphemeral(payload: Uint8Array): Promise<void> {
    return this.#owner.publishEphemeral(payload)
  }

  get doc(): A.Doc<T> {
    return (this.#doc ??= A.init<T>())
  }

  /** Set by {@link DocumentState.close}; edits and inbound data are then rejected. */
  get closed(): boolean {
    return this.#closed
  }

  close(): void {
    this.#closed = true
    this.discardRemoteHeads()
  }

  get ready(): boolean {
    return this.query.state().status === "ready"
  }

  /** Mark deleted, settle the query, then notify every handle. Idempotent. */
  delete(): void {
    if (this.deleted) return
    this.deleted = true
    // Settle acquisition before delete listeners can synchronously find the ID.
    this.query.deleted()
    this.registry.dispatchDelete()
  }

  /** Inspect without materializing an empty Automerge document. */
  peekDoc(): A.Doc<T> | undefined {
    return this.#doc
  }

  heads(): string[] {
    return this.#doc ? A.getHeads(this.#doc) : []
  }

  getSyncInfo(peerId: PeerId): SyncInfo | undefined {
    return this.#syncInfo.get(peerId)
  }

  recordRemoteHeads(peerId: PeerId, heads: readonly string[]): void {
    const encoded = encodeHeads([...heads])
    const timestamp = Date.now()
    this.#syncInfo.set(peerId, {
      lastHeads: encoded,
      lastSyncTimestamp: timestamp,
    })
    if (!this.ready) {
      this.#pendingRemoteHeads.add(peerId)
      return
    }
    // A later report supersedes one still awaiting the flush.
    this.#pendingRemoteHeads.delete(peerId)
    this.registry.dispatchRemoteHeads(peerId, encoded, timestamp)
  }

  /** Deliver pre-ready reports in a later task, after `find()` callers attach. */
  flushRemoteHeads(): void {
    if (!this.#pendingRemoteHeads.size) return
    const timer = setTimeout(() => {
      const pending = [...this.#pendingRemoteHeads]
      this.#pendingRemoteHeads.clear()
      if (this.closed || this.deleted) return
      for (const peerId of pending) {
        const info = this.#syncInfo.get(peerId)!
        this.registry.dispatchRemoteHeads(
          peerId,
          info.lastHeads,
          info.lastSyncTimestamp
        )
      }
    }, 0)
    ;(timer as { unref?: () => void }).unref?.()
  }

  /** Drop pre-ready reports; the query settled without becoming ready. */
  discardRemoteHeads(): void {
    this.#pendingRemoteHeads.clear()
  }

  /**
   * The whole document at `heads` (the live snapshot when `heads` is
   * undefined). Views are memoized per snapshot so repeated reads from
   * view-pinned handles don't re-run `A.view`.
   */
  viewAt(heads: UrlHeads | undefined): A.Doc<T> {
    if (!heads) return this.doc
    const key = [...heads].sort().join(",")
    return this.#viewCache.getOrCompute(
      key,
      () => A.view(this.doc, decodeHeads(heads)) as A.Doc<T>
    )
  }

  /**
   * Run `mutator`, adopt its result, and fan `heads-changed` / `change`
   * out via the registry. No dispatch if heads didn't move. Pairing
   * mutation and dispatch here means callers can't forget the dispatch.
   */
  applyMutation(
    mutator: (doc: A.Doc<any>) => A.Doc<any>,
    options: { incoming?: boolean; initial?: boolean; compact?: boolean } = {}
  ): Promise<void> {
    if (this.deleted) throw new Error("Document is deleted")
    if (this.closed) throw new Error("Document is closed")
    if (!options.incoming && !this.ready)
      throw new Error("Document is not ready")
    if (!options.incoming && this.writeFailure)
      return Promise.reject(this.writeFailure.error)
    const before = this.doc
    const after = mutator(before)
    return this.#adopt(before, after, options)
  }

  /** Adopt the first storage snapshot without allocating an empty WASM document. */
  applyLoaded(after: A.Doc<T>, initial: boolean): Promise<void> {
    if (this.deleted) throw new Error("Document is deleted")
    if (this.closed) throw new Error("Document is closed")
    return this.#adopt(this.#doc, after, { incoming: true, initial })
  }

  #adopt(
    before: A.Doc<T> | undefined,
    after: A.Doc<T>,
    options: { incoming?: boolean; initial?: boolean; compact?: boolean }
  ): Promise<void> {
    // Always adopt the new snapshot even when heads are unchanged -
    // `A.change` can hand back a fresh snapshot whose `before` is now
    // "outdated" for subsequent mutations.
    this.#doc = after
    const beforeHeads = before ? A.getHeads(before) : []
    const afterHeads = A.getHeads(after)
    const stored =
      options.incoming || !before
        ? Promise.resolve()
        : this.#owner.commit(before, after, { compact: options.compact })
    void stored.catch(() => {})
    if (arraysAreEqual(beforeHeads, afterHeads)) return stored
    const initial =
      options.incoming && options.initial && beforeHeads.length === 0
    const patches = initial ? undefined : A.diff(after, beforeHeads, afterHeads)
    this.#events.push(() => {
      this.registry.dispatchHeadsChanged(after)
      // A heads listener can attach a change listener during dispatch.
      if (initial && !this.registry.hasChangeListeners()) return
      const changes = patches ?? A.diff(after, beforeHeads, afterHeads)
      if (changes.length > 0) {
        this.registry.dispatchChange(after, changes, {
          before: before ?? (A.view(after, []) as A.Doc<T>),
          after,
          source: "change",
        })
      }
    })
    if (!this.#dispatching) {
      this.#dispatching = true
      try {
        while (this.#events.length) this.#events.shift()!()
      } finally {
        this.#dispatching = false
      }
    }
    return stored
  }
}
