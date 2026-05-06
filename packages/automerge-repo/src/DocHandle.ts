import { next as A } from "@automerge/automerge/slim"
import { EventEmitter } from "eventemitter3"
import {
  decodeHeads,
  encodeHeads,
  stringifyAutomergeUrl,
} from "./AutomergeUrl.js"
import { encode } from "./helpers/cbor.js"
import { headsAreSame } from "./helpers/headsAreSame.js"
import type { AutomergeUrl, DocumentId, PeerId, UrlHeads } from "./types.js"
import { StorageId } from "./storage/types.js"
import type { PathInput, InferRefType, Ref } from "./refs/types.js"
import { foreverPromise } from "./helpers/foreverPromise.js"
import { WeakValueMap } from "./helpers/WeakValueMap.js"

/**
 * A DocHandle is a wrapper around a single Automerge document that lets us listen for changes and
 * notify the network and storage of new changes.
 *
 * @remarks
 * A `DocHandle` represents a document which is being managed by a {@link Repo}. You shouldn't ever
 * instantiate this yourself. To obtain `DocHandle` use {@link Repo.find} or {@link Repo.create}.
 *
 * To modify the underlying document use either {@link DocHandle.change} or
 * {@link DocHandle.changeAt}. These methods will notify the `Repo` that some change has occured and
 * the `Repo` will save any new changes to the attached {@link StorageAdapter} and send sync
 * messages to connected peers.
 */
export class DocHandle<T> extends EventEmitter<DocHandleEvents<T>> {
  /** If set, this handle will only show the document at these heads */
  #fixedHeads?: UrlHeads

  #doc: A.Doc<T>

  /** Cache for view handles, keyed by the stringified heads. Values are
   * held weakly so unused views are eligible for GC. */
  #viewCache = new WeakValueMap<string, DocHandle<T>>()

  /** Cache for ref instances, keyed by serialized path. Values are held
   * weakly so unused refs are eligible for GC. */
  #refCache = new WeakValueMap<string, Ref<any>>()

  #deleted = false

  // Injected by Repo so `getSyncInfo()` / `getRemoteHeads()` can delegate
  // to the central SyncStateTracker.
  #syncInfoLookup?: (storageId: StorageId) => SyncInfo | undefined

  /** Factory for creating Ref instances, injected by Repo to avoid circular imports */
  #refConstructor: <TDoc, TPath extends readonly PathInput[]>(
    handle: DocHandle<TDoc>,
    path: [...TPath]
  ) => Ref<any>

  /** @hidden */
  constructor(
    public documentId: DocumentId,
    refConstructor: <TDoc, TPath extends readonly PathInput[]>(
      handle: DocHandle<TDoc>,
      path: [...TPath]
    ) => Ref<any>,
    options: DocHandleOptions<T> = {},
    /**
     * @hidden
     */
    syncInfoLookup?: (storageId: StorageId) => SyncInfo | undefined
  ) {
    super()
    this.#refConstructor = refConstructor

    if ("isNew" in options && options.isNew) {
      this.#doc = A.emptyChange(A.init<T>())
    } else {
      this.#doc = A.init<T>()
    }
    // TODO: remove this in the next major. Callers should use
    // `repo.find(urlWithHeads)` or `handle.view(heads)` instead.
    if ("heads" in options && options.heads) {
      this.#fixedHeads = options.heads
    }
    this.#syncInfoLookup = syncInfoLookup
    // Registered first so any user-attached `delete` listener observes
    // `isDeleted() === true`.
    this.on("delete", () => {
      this.#deleted = true
    })
  }

  // PRIVATE

  /**
   * Called after state transitions. If the document has changed, emits a change event. If we just
   * received the document for the first time, signal that our request has been completed.
   */
  #emitChanges(before: A.Doc<T>, after: A.Doc<T>) {
    const beforeHeads = A.getHeads(before)
    const afterHeads = A.getHeads(after)
    const docChanged = !headsAreSame(
      encodeHeads(afterHeads),
      encodeHeads(beforeHeads)
    )
    if (docChanged) {
      this.emit("heads-changed", { handle: this, doc: after })

      const patches = A.diff(after, beforeHeads, afterHeads)
      if (patches.length > 0) {
        this.emit("change", {
          handle: this,
          doc: after,
          patches,
          // TODO: pass along the source (load/change/network)
          patchInfo: { before, after, source: "change" },
        })
      }
    }
  }

  // PUBLIC

  /** Our documentId in Automerge URL form.
   */
  get url(): AutomergeUrl {
    return stringifyAutomergeUrl({
      documentId: this.documentId,
      heads: this.#fixedHeads,
    })
  }

  // TODO: remove the legacy state-machine accessors below in the next major.
  // Handles are only handed out to consumers in the `ready` state, so the
  // only meaningful transition that remains is ready → deleted.

  /**
   * @returns true if the document has not been deleted. Repo only hands out
   * handles that already have data, so this is `true` from construction
   * unless `delete()` is called.
   */
  isReady = () => !this.#deleted

  /**
   * @returns true if the document has been unloaded.
   */
  isUnloaded = () => false

  /**
   * @returns true if the document has been marked as deleted.
   */
  isDeleted = () => this.#deleted

  /**
   * @returns true if the document is currently unavailable.
   * @deprecated Always returns false — `find()` rejects on unavailable docs
   * rather than returning a handle. Will be removed in the next major.
   */
  isUnavailable = () => false

  /**
   * @returns true if the handle is in one of the given states.
   * @deprecated Will be removed in the next major.
   */
  inState = (states: HandleState[]) => states.includes(this.state)

  /** @hidden */
  get state(): HandleState {
    return this.#deleted ? "deleted" : "ready"
  }

  /**
   * Returns a promise that resolves when the handle is in one of the given
   * states (default `["ready"]`).
   *
   * @deprecated Handles are always ready when handed out by `Repo.find` /
   * `Repo.create`. Will be removed in the next major.
   */
  async whenReady(awaitStates: HandleState[] = ["ready"]): Promise<void> {
    if (awaitStates.includes(this.state)) return
    if (awaitStates.includes("deleted")) {
      await new Promise<void>(resolve => this.once("delete", () => resolve()))
      return
    }
    // No path to other states from a handed-out handle.
    return foreverPromise
  }

  /**
   * Returns the current state of the Automerge document this handle manages.
   *
   * @returns the current document
   * @throws on deleted and unavailable documents
   *
   */
  doc(): A.Doc<T> {
    return this.#doc
  }

  /**
   * @deprecated Use doc() instead.
   */
  docSync() {
    console.warn(
      "docSync is deprecated. Use doc() instead. This function will be removed as part of the 2.0 release."
    )
    return this.doc()
  }

  /**
   * Returns the current "heads" of the document, akin to a git commit.
   * This precisely defines the state of a document.
   * @returns the current document's heads, or undefined if the document is not ready
   */
  heads(): UrlHeads {
    return encodeHeads(A.getHeads(this.#doc))
  }

  /** @hidden */
  begin() {
    // noop - state machine removed
  }

  /**
   * Returns an array of all past "heads" for the document in topological order.
   *
   * @remarks
   * A point-in-time in an automerge document is an *array* of heads since there may be
   * concurrent edits. This API just returns a topologically sorted history of all edits
   * so every previous entry will be (in some sense) before later ones, but the set of all possible
   * history views would be quite large under concurrency (every thing in each branch against each other).
   * There might be a clever way to think about this, but we haven't found it yet, so for now at least
   * we present a single traversable view which excludes concurrency.
   * @returns UrlHeads[] - The individual heads for every change in the document. Each item is a tagged string[1].
   */
  history(): UrlHeads[] {
    return A.topoHistoryTraversal(this.#doc).map(h =>
      encodeHeads([h])
    ) as UrlHeads[]
  }

  /**
   * Creates a fixed "view" of an automerge document at the given point in time represented
   * by the `heads` passed in. The return value is the same type as doc() and will return
   * undefined if the object hasn't finished loading.
   *
   * @remarks
   * Note that our Typescript types do not consider change over time and the current version
   * of Automerge doesn't check types at runtime, so if you go back to an old set of heads
   * that doesn't match the heads here, Typescript will not save you.
   *
   * @argument heads - The heads to view the document at. See history().
   * @returns DocHandle<T> at the time of `heads`
   */
  view(heads: UrlHeads): DocHandle<T> {
    return this.#viewCache.getOrCompute(JSON.stringify(heads), () => {
      const handle = new DocHandle<T>(
        this.documentId,
        this.#refConstructor,
        {},
        this.#syncInfoLookup
      )
      handle.#doc = A.view(this.#doc, decodeHeads(heads))
      handle.#fixedHeads = heads
      return handle
    })
  }

  /**
   * Returns a set of Patch operations that will move a materialized document from one state to another
   * if applied.
   *
   * @remarks
   * We allow specifying either:
   * - Two sets of heads to compare directly
   * - A single set of heads to compare against our current heads
   * - Another DocHandle to compare against (which must share history with this document)
   *
   * @throws Error if the documents don't share history or if either document is not ready
   * @returns Automerge patches that go from one document state to the other
   */
  diff(first: UrlHeads | DocHandle<T>, second?: UrlHeads): A.Patch[] {
    const doc = this.#doc

    // If first argument is a DocHandle
    if (first instanceof DocHandle) {
      const otherHeads = first.heads()

      // Create a temporary merged doc to verify shared history and compute diff
      const mergedDoc = A.merge(A.clone(doc), first.doc())
      // Use the merged doc to compute the diff
      return A.diff(
        mergedDoc,
        decodeHeads(this.heads()),
        decodeHeads(otherHeads)
      )
    }

    // Otherwise treat as heads
    const from = second ? first : (this.heads() as UrlHeads)
    const to = second ? second : first
    return A.diff(doc, decodeHeads(from), decodeHeads(to))
  }

  /**
   * `metadata(head?)` allows you to look at the metadata for a change
   * this can be used to build history graphs to find commit messages and edit times.
   * this interface.
   *
   * @remarks
   * I'm really not convinced this is the right way to surface this information so
   * I'm leaving this API "hidden".
   *
   * @hidden
   */
  metadata(change?: string): A.DecodedChange | undefined {
    if (!change) {
      change = this.heads()[0]
    }
    if (!change) return undefined
    // we return undefined instead of null by convention in this API
    return (
      A.inspectChange(this.#doc, decodeHeads([change] as UrlHeads)[0]) ||
      undefined
    )
  }

  /**
   * `update` is called any time we have a new document state; could be
   * from a local change, a remote change, or a new document from storage.
   * Does not cause state changes.
   * @hidden
   */
  update(callback: (doc: A.Doc<T>) => A.Doc<T>) {
    const oldDoc = this.#doc
    const newDoc = callback(oldDoc)
    // For fixed-heads handles (e.g. constructed with `{ heads }` and
    // populated via `update`), persist the snapshot at those heads so
    // doc() / heads() reflect the pinned point in time.
    this.#doc = this.#fixedHeads
      ? A.view(newDoc, decodeHeads(this.#fixedHeads))
      : newDoc
    this.#emitChanges(oldDoc, this.#doc)
  }

  #throwIfFixedHeads(operation: string) {
    if (this.#fixedHeads) {
      throw new Error(
        `Cannot ${operation} on DocHandle#${this.documentId}: it is in view-only mode at specific heads.`
      )
    }
  }

  /**
   * `doneLoading` is called by the repo after it decides it has all the changes
   * it's going to get during setup. This might mean it was created locally,
   * or that it was loaded from storage, or that it was received from a peer.
   * @hidden
   */
  doneLoading() {
    // noop - state machine removed
  }

  /** Returns the latest known heads for the given peer's storageId, or
   * undefined if we have not received sync info from that peer.
   *
   * @deprecated Use {@link DocHandle.getSyncInfo} instead. Will be removed in the next major.
   */
  getRemoteHeads(storageId: StorageId): UrlHeads | undefined {
    return this.#syncInfoLookup?.(storageId)?.lastHeads
  }

  /** Returns the heads and the timestamp of the last update for the storageId. */
  getSyncInfo(storageId: StorageId): SyncInfo | undefined {
    return this.#syncInfoLookup?.(storageId)
  }

  /**
   * All changes to an Automerge document should be made through this method.
   * Inside the callback, the document should be treated as mutable: all edits will be recorded
   * using a Proxy and translated into operations as part of a single recorded "change".
   *
   * Note that assignment via ES6 spread operators will result in *replacing* the object
   * instead of mutating it which will prevent clean merges. This may be what you want, but
   * `doc.foo = { ...doc.foo, bar: "baz" }` is not equivalent to `doc.foo.bar = "baz"`.
   *
   * Local changes will be stored (by the StorageSubsystem) and synchronized (by the
   * DocSynchronizer) to any peers you are sharing it with.
   *
   * @param callback - A function that takes the current document and mutates it.
   *
   */
  change(callback: A.ChangeFn<T>, options: A.ChangeOptions<T> = {}) {
    this.#throwIfFixedHeads("change")
    this.update(doc => A.change(doc, options, callback))
  }

  /**
   * Makes a change as if the document were at `heads`.
   *
   * @returns A set of heads representing the concurrent change that was made.
   */
  changeAt(
    heads: UrlHeads,
    callback: A.ChangeFn<T>,
    options: A.ChangeOptions<T> = {}
  ): UrlHeads | undefined {
    this.#throwIfFixedHeads("changeAt")
    let resultHeads: UrlHeads | undefined = undefined
    this.update(doc => {
      const result = A.changeAt(doc, decodeHeads(heads), options, callback)
      resultHeads = result.newHeads ? encodeHeads(result.newHeads) : undefined
      return result.newDoc
    })
    return resultHeads
  }

  /**
   * Check if the document can be change()ed. Currently, documents can be
   * edited unless we are viewing a particular point in time.
   *
   * @remarks It is technically possible to back-date changes using changeAt(),
   *          but we block it for usability reasons when viewing a particular point in time.
   *          To make changes in the past, use the primary document handle with no heads set.
   *
   * @returns boolean indicating whether changes are possible
   */
  isReadOnly() {
    return !!this.#fixedHeads
  }

  /**
   * Merges another document into this document. Any peers we are sharing changes with will be
   * notified of the changes resulting from the merge.
   *
   * @returns the merged document.
   *
   * @throws if either document is not ready or if `otherHandle` is unavailable.
   */
  merge(
    /** the handle of the document to merge into this one */
    otherHandle: DocHandle<T>
  ) {
    this.#throwIfFixedHeads("merge")
    this.update(doc => A.merge(doc, otherHandle.doc()))
  }

  /**
   * Updates the internal state machine to mark the document unavailable.
   * @hidden
   */
  unavailable() {
    // noop - state machine removed
  }

  /**
   * Called by the repo either when the document is not found in storage.
   * @hidden
   * */
  request() {
    // noop - state machine removed
  }

  /** Called by the repo to free memory used by the document. */
  unload() {
    // noop - state machine removed
  }

  /** Called by the repo to reuse an unloaded handle. */
  reload() {
    // noop - state machine removed
  }

  /** Called by the repo when the document is deleted. */
  delete() {
    this.emit("delete", { handle: this })
  }

  /**
   * Sends an arbitrary ephemeral message out to all reachable peers who would receive sync messages
   * from you. It has no guarantee of delivery, and is not persisted to the underlying automerge doc
   * in any way. Messages will have a sending PeerId but this is *not* a useful user identifier (a
   * user could have multiple tabs open and would appear as multiple PeerIds). Every message source
   * must have a unique PeerId.
   */
  broadcast(message: unknown) {
    this.emit("ephemeral-message-outbound", {
      handle: this,
      data: new Uint8Array(encode(message)),
    })
  }

  metrics(): { numOps: number; numChanges: number } {
    return A.stats(this.#doc)
  }

  /**
   * Create a ref to a location in this document.
   *
   * Returns the same ref instance for the same path, ensuring referential equality.
   *
   * @experimental This API is experimental and may change in future versions.
   *
   * @example
   * ```ts
   * const titleRef = handle.ref('todos', 0, 'title');
   * titleRef.value(); // string | undefined
   *
   * // Same ref instance is returned for same path
   * const sameRef = handle.ref('todos', 0, 'title');
   * titleRef === sameRef; // true
   * ```
   */
  ref<TPath extends readonly PathInput[]>(
    ...segments: [...TPath]
  ): Ref<InferRefType<T, TPath>> {
    return this.#refCache.getOrCompute(this.#pathToCacheKey(segments), () =>
      this.#refConstructor<T, TPath>(this, segments as [...TPath])
    ) as Ref<InferRefType<T, TPath>>
  }

  /**
   * Create a stable cache key from path segments.
   * Serializes the path to a string for comparison.
   */
  #pathToCacheKey(segments: readonly PathInput[]): string {
    return segments
      .map(seg => {
        if (typeof seg === "string") return `s:${seg}`
        if (typeof seg === "number") return `n:${seg}`
        if (typeof seg === "object" && seg !== null) {
          // Pattern or CursorMarker
          return `o:${JSON.stringify(seg)}`
        }
        return `?:${String(seg)}`
      })
      .join("/")
  }
}

//  TYPES

export type SyncInfo = {
  lastHeads: UrlHeads
  lastSyncTimestamp: number
}

/** @hidden */
export type DocHandleOptions<T> =
  | // NEW DOCUMENTS
  {
      /** If we know this is a new document (because we're creating it) this should be set to true. */
      isNew: true

      /** The initial value of the document. */
      initialValue?: T
    } // EXISTING DOCUMENTS
  | {
      isNew?: false

      // An optional point in time to lock the document to.
      heads?: UrlHeads

      /** The number of milliseconds before we mark this document as unavailable if we don't have it and nobody shares it with us. */
      timeoutDelay?: number
    }

// EXTERNAL EVENTS

/** These are the events that this DocHandle emits to external listeners */
export interface DocHandleEvents<T> {
  "heads-changed": (payload: DocHandleEncodedChangePayload<T>) => void
  change: (payload: DocHandleChangePayload<T>) => void
  delete: (payload: DocHandleDeletePayload<T>) => void
  "ephemeral-message": (payload: DocHandleEphemeralMessagePayload<T>) => void
  "ephemeral-message-outbound": (
    payload: DocHandleOutboundEphemeralMessagePayload<T>
  ) => void
  "remote-heads": (payload: DocHandleRemoteHeadsPayload) => void
}

/** Emitted when this document's heads have changed */
export interface DocHandleEncodedChangePayload<T> {
  handle: DocHandle<T>
  doc: A.Doc<T>
}

/** Emitted when this document has changed */
export interface DocHandleChangePayload<T> {
  /** The handle that changed */
  handle: DocHandle<T>
  /** The value of the document after the change */
  doc: A.Doc<T>
  /** The patches representing the change that occurred */
  patches: A.Patch[]
  /** Information about the change */
  patchInfo: A.PatchInfo<T>
}

/** Emitted when this document is deleted */
export interface DocHandleDeletePayload<T> {
  handle: DocHandle<T>
}

/** Emitted when this document has been marked unavailable */
export interface DocHandleUnavailablePayload<T> {
  handle: DocHandle<T>
}

/** Emitted when an ephemeral message is received for the document */
export interface DocHandleEphemeralMessagePayload<T> {
  handle: DocHandle<T>
  senderId: PeerId
  message: unknown
}

/** Emitted when an ephemeral message is sent for this document */
export interface DocHandleOutboundEphemeralMessagePayload<T> {
  handle: DocHandle<T>
  data: Uint8Array
}

/** Emitted when we have new remote heads for this document */
export interface DocHandleRemoteHeadsPayload {
  storageId: StorageId
  heads: UrlHeads
  timestamp: number
}

// STATE MACHINE TYPES & CONSTANTS

// state

/**
 * Possible internal states for a DocHandle
 */
export const HandleState = {
  /** The handle has been created but not yet loaded or requested */
  IDLE: "idle",
  /** We are waiting for storage to finish loading */
  LOADING: "loading",
  /** We are waiting for someone in the network to respond to a sync request */
  REQUESTING: "requesting",
  /** The document is available */
  READY: "ready",
  /** The document has been unloaded from the handle, to free memory usage */
  UNLOADED: "unloaded",
  /** The document has been deleted from the repo */
  DELETED: "deleted",
  /** The document was not available in storage or from any connected peers */
  UNAVAILABLE: "unavailable",
} as const
export type HandleState = (typeof HandleState)[keyof typeof HandleState]

export const {
  IDLE,
  LOADING,
  REQUESTING,
  READY,
  UNLOADED,
  DELETED,
  UNAVAILABLE,
} = HandleState
