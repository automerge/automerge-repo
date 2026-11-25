import { makeLogger, Logger } from "./Logger.js"
import { decodeHeads, encodeHeads } from "./AutomergeUrl.js"
import type { DocumentId, PeerId, RepoId, SyncInfo, UrlHeads } from "./types.js"
import { Listeners } from "./Listeners.js"
import { WeakValueMap } from "./helpers/WeakValueMap.js"
import { arraysAreEqual } from "./sedimentree/arraysAreEqual.js"
import type { AnyHandleKind, DocHandle } from "./types/DocHandle.js"
import {
  Handle as BaseHandle,
  handleChangeEventPayload,
  type StateChange,
} from "./Handle.js"
import { extendHandle } from "./DocHandle.js"
import { RootQuery } from "./DocumentQuery.js"
import type { Document } from "./Document.js"
import type { ExtensionContext } from "./sedimentree/extension.js"
import type { AnyDocType, DocTypeContext } from "./DocType.js"
import type { Handle } from "./Handle.js"
import { automerge } from "./automerge/docType.js"

/** What a {@link DocumentState} asks of the {@link Document} that owns it. */
type Owner = Pick<Document, "commit"> &
  Partial<Pick<Document, "Handle" | "extensionContext" | "docType" | "repoId">>

/**
 * Per-document shared state - one per `documentId`, referenced by every
 * `DocHandle` (root, sub, view) into that document. Owns the doc type's
 * current state, the root handle, its readiness query, and the
 * {@link Listeners} of every handle. The state is opaque here: only the doc
 * type's functions read or change it.
 * Local edits go out through its owning {@link Document}. Not part of the
 * public API.
 *
 * @internal
 */
export class DocumentState {
  readonly documentId: DocumentId
  /** How the state is stored, read and changed. */
  readonly docType: AnyDocType
  /** What the type is told about this document. */
  readonly context: DocTypeContext
  /** View handles, keyed by heads and weakly held. */
  readonly handles = new WeakValueMap<string, Handle<any, any, any>>()
  readonly listeners: Listeners
  readonly log: Logger
  /** The class of every handle of this document. */
  readonly Handle: typeof BaseHandle
  /** The root handle Repo hands out. */
  readonly handle: DocHandle<any, {}, AnyHandleKind>
  /** Owns readiness. */
  readonly query: RootQuery<any>
  readonly #owner: Owner

  /** No state (`undefined`) until storage, peer history, or a caller needs
   * one. Any other value, even `null` or `0`, is a state. */
  #current?: unknown

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
  /** Repo-internal; kept apart from handle listeners so public removal can't detach them. */
  #headsSubscribers = new Set<() => void>()

  /**
   * The doc type's views, keyed by heads. Heads precisely specify an
   * immutable state, so a view never changes once computed and the cache
   * never needs invalidating - the live state only ever grows past these
   * heads, and a view at a historical point is identical regardless.
   *
   * Held weakly: heads keys are unbounded over a document's life. A view
   * stays cached while held and is recomputed on a cold read. Only objects
   * can be held weakly: other views are recomputed on every read.
   */
  #viewCache = new WeakValueMap<string, object>()

  /** The owner is only stored here, not called, so it may still be constructing. */
  constructor(documentId: DocumentId, owner: Owner, initial?: unknown) {
    this.documentId = documentId
    this.#owner = owner
    this.#current = initial
    this.docType = owner.docType ?? automerge
    this.context = {
      documentId,
      repoId: owner.repoId ?? ("" as RepoId),
    }
    this.log = makeLogger(`automerge-repo:doc:${documentId.slice(0, 5)}`)
    this.listeners = new Listeners(this.log)
    this.Handle =
      owner.Handle ??
      extendHandle([], (this.docType.handle ?? BaseHandle) as typeof BaseHandle)
    this.handle = new this.Handle(this) as DocHandle<any, {}, AnyHandleKind>
    this.query = new RootQuery(this.handle as DocHandle<any>)
  }

  /** What handle extensions can do with this document. */
  get extensionContext(): ExtensionContext {
    const context = this.#owner.extensionContext
    if (!context) throw new Error("Document has no backend")
    return context
  }

  /** The doc type's current state, made empty on first need. */
  get current(): unknown {
    if (this.#current === undefined)
      this.#current = this.docType.apply(undefined, [])
    return this.#current
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
    this.listeners.emitAll("delete", handle => ({ handle }))
  }

  /** The current state, without making an empty one. */
  peek(): unknown {
    return this.#current
  }

  heads(): string[] {
    return this.#current === undefined ? [] : this.docType.heads(this.#current)
  }

  /** Call `fn` after each heads change, after handle listeners. Returns an unsubscribe. */
  onHeadsChanged(fn: () => void): () => void {
    const entry = () => fn()
    this.#headsSubscribers.add(entry)
    return () => void this.#headsSubscribers.delete(entry)
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
    this.#dispatchRemoteHeads(peerId, encoded, timestamp)
  }

  #dispatchRemoteHeads(
    peerId: PeerId,
    heads: UrlHeads,
    timestamp: number
  ): void {
    this.listeners.emitAll("remote-heads", () => ({ peerId, heads, timestamp }))
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
        this.#dispatchRemoteHeads(
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
   * The state as of `heads` (the current state when `heads` is undefined).
   * Views are memoized per heads so repeated reads from view-pinned handles
   * don't recompute them.
   */
  viewAt(heads: UrlHeads | undefined): unknown {
    if (!heads) return this.current
    const docType = this.docType
    if (!docType.view)
      throw new Error(`${docType.scheme} documents have no views`)
    const key = [...heads].sort().join(",")
    const cached = this.#viewCache.get(key)
    if (cached !== undefined) return cached
    const view: unknown = docType.view(this.current, decodeHeads(heads))
    if (typeof view === "object" && view !== null)
      this.#viewCache.set(key, view)
    return view
  }

  /**
   * Run `mutator`, adopt its result, and fan `heads-changed` / `change`
   * out to listening handles. No dispatch if heads didn't move. Pairing
   * mutation and dispatch here means callers can't forget the dispatch.
   */
  applyMutation(
    mutator: (state: any) => unknown,
    options: { incoming?: boolean; compact?: boolean } = {}
  ): Promise<void> {
    if (this.deleted) throw new Error("Document is deleted")
    if (this.closed) throw new Error("Document is closed")
    if (!options.incoming && !this.ready)
      throw new Error("Document is not ready")
    if (!options.incoming && this.writeFailure)
      return Promise.reject(this.writeFailure.error)
    const before = this.current
    // Read first: a type may change its state in place.
    const beforeHeads = this.docType.heads(before)
    const after = mutator(before)
    return this.#adopt(before, beforeHeads, after, options)
  }

  /** Adopt the first loaded state without making an empty one first. */
  applyLoaded(after: unknown): Promise<void> {
    if (this.deleted) throw new Error("Document is deleted")
    if (this.closed) throw new Error("Document is closed")
    const before = this.#current
    const beforeHeads = before === undefined ? [] : this.docType.heads(before)
    return this.#adopt(before, beforeHeads, after, { incoming: true })
  }

  /** Deliver `change` to every writable listening handle that describes one. */
  #dispatchChange(change: StateChange): void {
    for (const handle of this.listeners.handles()) {
      if (handle.isReadOnly() || this.listeners.count(handle, "change") === 0)
        continue
      let payload: unknown
      try {
        payload = handleChangeEventPayload(handle, change)
      } catch (e) {
        this.log.error("error in changeEventPayload: %o", e)
        continue
      }
      if (payload !== undefined) this.listeners.emit(handle, "change", payload)
    }
  }

  #adopt(
    before: unknown,
    beforeHeads: string[],
    after: unknown,
    options: { incoming?: boolean; compact?: boolean }
  ): Promise<void> {
    // Always adopt the new state even when heads are unchanged: a type with
    // immutable states can hand back a fresh one that `before` no longer
    // matches for subsequent mutations.
    this.#current = after
    const afterHeads = this.docType.heads(after)
    const stored =
      options.incoming || before === undefined
        ? Promise.resolve()
        : this.#owner.commit(beforeHeads, after, { compact: options.compact })
    void stored.catch(() => {})
    if (arraysAreEqual(beforeHeads, afterHeads)) return stored
    const change: StateChange = { before, beforeHeads, after, afterHeads }
    this.#events.push(() => {
      // Heads are document-level: the payload is the whole document's value.
      let value: { doc: unknown } | undefined
      this.listeners.emitAll(
        "heads-changed",
        handle => ({
          handle,
          doc: (value ??= { doc: this.docType.value(after) }).doc,
        }),
        { writableOnly: true }
      )
      for (const fn of [...this.#headsSubscribers]) {
        try {
          fn()
        } catch (e) {
          this.log.error("error in heads subscriber: %o", e)
        }
      }
      this.#dispatchChange(change)
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
