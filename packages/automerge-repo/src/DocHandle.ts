import { next as A, ChangeFn } from "@automerge/automerge/slim"
import debug from "debug"
import { EventEmitter } from "eventemitter3"
import { assertEvent, assign, createActor, setup, waitFor } from "xstate"
import {
  decodeHeads,
  encodeHeads,
  stringifyAutomergeUrl,
} from "./AutomergeUrl.js"
import { encode } from "./helpers/cbor.js"
import { headsAreSame } from "./helpers/headsAreSame.js"
import { withTimeout } from "./helpers/withTimeout.js"
import type { AutomergeUrl, DocumentId, PeerId, UrlHeads } from "./types.js"
import { StorageId } from "./storage/types.js"
import { DocMessage } from "./network/messages.js"
import { DocumentPhasor } from "./DocumentPhasor.js"

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
  #log: debug.Debugger

  /** If set, this handle will only show the document at these heads */
  #fixedHeads?: UrlHeads

  /** The last known state of our document. */
  #prevDocState: T = A.init<T>()

  /** How long to wait before giving up on a document. (Note that a document will be marked
   * unavailable much sooner if all known peers respond that they don't have it.) */
  #timeoutDelay = 60_000

  /** A dictionary mapping each peer to the last known heads we have. */
  #syncInfoByStorageId: Record<StorageId, SyncInfo> = {}

  /** Cache for view handles, keyed by the stringified heads */
  #viewCache: Map<string, DocHandle<T>> = new Map()

  #localChangeHandler: <R>(
    f: (doc: A.Doc<T>) => { newDoc: A.Doc<T>; result: R }
  ) => R
  #state: HandleState
  #listeners: { resolve: () => void; states: HandleState[] }[] = []
  #doc: () => A.Doc<T>

  /** @hidden */
  constructor(
    public documentId: DocumentId,
    localHandler: <R>(
      f: (doc: A.Doc<T>) => { newDoc: A.Doc<T>; result: R }
    ) => R,
    doc: () => A.Doc<T>,
    options: DocHandleOptions<T> = {}
  ) {
    super()

    if ("timeoutDelay" in options && options.timeoutDelay) {
      this.#timeoutDelay = options.timeoutDelay
    }

    if ("heads" in options) {
      this.#fixedHeads = options.heads
    }

    this.#log = debug(`automerge-repo:dochandle:${this.documentId.slice(0, 5)}`)

    this.#localChangeHandler = localHandler
    this.#doc = doc
    this.#state = "idle"
    this.#listeners = []
  }

  // PRIVATE

  setState(state: HandleState) {
    this.#state = state
    // Fire and remove listeners
    const toFire: (() => void)[] = []
    this.#listeners = this.#listeners.filter(l => {
      if (l.states.includes(state)) {
        toFire.push(l.resolve)
        return false
      }
      return true
    })
    for (const listener of toFire) {
      listener()
    }
    if (state === "deleted") {
      this.emit("delete", { handle: this })
    }
  }

  #statePromise(awaitStates: HandleState[]): Promise<void> {
    if (awaitStates.includes(this.#state)) {
      return Promise.resolve()
    }
    return new Promise(resolve => {
      this.#listeners.push({ states: awaitStates, resolve })
    })
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

  /** @hidden */
  get state() {
    return this.#state
  }

  /**
   * @returns true if the document is ready for accessing or changes.
   *
   * Note that for documents already stored locally this occurs before synchronization with any
   * peers. We do not currently have an equivalent `whenSynced()`.
   */
  isReady = () => this.inState(["ready"])

  /**
   * @returns true if the document has been unloaded.
   *
   * Unloaded documents are freed from memory but not removed from local storage. It's not currently
   * possible at runtime to reload an unloaded document.
   */
  isUnloaded = () => this.inState(["unloaded"])

  /**
   * @returns true if the document has been marked as deleted.
   *
   * Deleted documents are removed from local storage and the sync process. It's not currently
   * possible at runtime to undelete a document.
   */
  isDeleted = () => this.inState(["deleted"])

  /**
   * @returns true if the document is currently unavailable.
   *
   * This will be the case if the document is not found in storage and no peers have shared it with us.
   */
  isUnavailable = () => this.inState(["unavailable"])

  /**
   * @returns true if the handle is in one of the given states.
   */
  inState = (states: HandleState[]) => states.includes(this.#state)

  /**
   * @returns a promise that resolves when the document is in one of the given states (if no states
   * are passed, when the document is ready)
   *
   * Use this to block until the document handle has finished loading. The async equivalent to
   * checking `inState()`.
   */
  async whenReady(awaitStates: HandleState[] = ["ready"]) {
    try {
      await withTimeout(this.#statePromise(awaitStates), this.#timeoutDelay)
    } catch (error) {
      console.log(
        `error waiting for ${
          this.documentId
        } to be in one of states: ${awaitStates.join(", ")}`
      )
      throw error
    }
  }

  /**
   * Returns the current state of the Automerge document this handle manages.
   *
   * @returns the current document
   * @throws on deleted and unavailable documents
   *
   */
  doc(): A.Doc<T> {
    if (!this.isReady()) throw new Error("DocHandle is not ready")
    if (this.#fixedHeads) {
      return A.view(this.#doc(), decodeHeads(this.#fixedHeads))
    }
    return this.#doc()
  }

  /**
   *
   * @deprecated */
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
    if (!this.isReady()) throw new Error("DocHandle is not ready")
    if (this.#fixedHeads) {
      return this.#fixedHeads
    }
    return encodeHeads(A.getHeads(this.#doc()))
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
  history(): UrlHeads[] | undefined {
    if (!this.isReady()) {
      return undefined
    }
    // This just returns all the heads as individual strings.

    return A.topoHistoryTraversal(this.#doc()).map(h =>
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
    if (!this.isReady()) {
      throw new Error(
        `DocHandle#${this.documentId} is not ready. Check \`handle.isReady()\` before calling view().`
      )
    }

    // Create a cache key from the heads
    const cacheKey = JSON.stringify(heads)

    // Check if we have a cached handle for these heads
    const cachedHandle = this.#viewCache.get(cacheKey)
    if (cachedHandle) {
      return cachedHandle
    }

    // Create a new handle with the same documentId but fixed heads
    const doc = this.#doc()
    const handle = new DocHandle<T>(
      this.documentId,
      f => {
        throw new Error("readonly document")
      },
      () => doc,
      {
        heads,
        timeoutDelay: this.#timeoutDelay,
      }
    )
    handle.setState("ready")

    // Store in cache
    this.#viewCache.set(cacheKey, handle)

    return handle
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
    if (!this.isReady()) {
      throw new Error(
        `DocHandle#${this.documentId} is not ready. Check \`handle.isReady()\` before calling diff().`
      )
    }

    const doc = this.#doc()
    if (!doc) throw new Error("Document not available")

    // If first argument is a DocHandle
    if (first instanceof DocHandle) {
      if (!first.isReady()) {
        throw new Error("Cannot diff against a handle that isn't ready")
      }
      const otherHeads = first.heads()
      if (!otherHeads) throw new Error("Other document's heads not available")

      // Create a temporary merged doc to verify shared history and compute diff
      const mergedDoc = A.merge(A.clone(doc), first.doc()!)
      // Use the merged doc to compute the diff
      return A.diff(
        mergedDoc,
        decodeHeads(this.heads()!),
        decodeHeads(otherHeads)
      )
    }

    // Otherwise treat as heads
    const from = second ? first : ((this.heads() || []) as UrlHeads)
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
    if (!this.isReady()) {
      return undefined
    }

    if (!change) {
      change = this.heads()![0]
    }
    // we return undefined instead of null by convention in this API
    return (
      A.inspectChange(this.#doc(), decodeHeads([change] as UrlHeads)[0]) ||
      undefined
    )
  }

  /**
   * Called by the repo when a doc handle changes or we receive new remote heads.
   * @hidden
   */
  setSyncInfo(storageId: StorageId, syncInfo: SyncInfo) {
    this.#syncInfoByStorageId[storageId] = syncInfo
    this.emit("remote-heads", {
      storageId,
      heads: syncInfo.lastHeads,
      timestamp: syncInfo.lastSyncTimestamp,
    })
  }

  /** Returns the heads of the storageId.
   *
   * @deprecated Use getSyncInfo instead.
   */
  getRemoteHeads(storageId: StorageId): UrlHeads | undefined {
    return this.#syncInfoByStorageId[storageId]?.lastHeads
  }

  /** Returns the heads and the timestamp of the last update for the storageId. */
  getSyncInfo(storageId: StorageId): SyncInfo | undefined {
    return this.#syncInfoByStorageId[storageId]
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
    if (!this.isReady()) {
      throw new Error(
        `DocHandle#${this.documentId} is in ${
          this.#state
        } and not ready. Check \`handle.isReady()\` before accessing the document.`
      )
    }

    if (this.#fixedHeads) {
      throw new Error(
        `DocHandle#${this.documentId} is in view-only mode at specific heads. Use clone() to create a new document from this state.`
      )
    }
    this.#localChangeHandler(doc => {
      return { newDoc: A.change(doc, options, callback), result: null }
    })
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
    if (!this.isReady()) {
      throw new Error(
        `DocHandle#${this.documentId} is not ready. Check \`handle.isReady()\` before accessing the document.`
      )
    }
    if (this.#fixedHeads) {
      throw new Error(
        `DocHandle#${this.documentId} is in view-only mode at specific heads. Use clone() to create a new document from this state.`
      )
    }

    const newHeads = this.#localChangeHandler(doc => {
      const result = A.changeAt(doc, decodeHeads(heads), options, callback)
      return { newDoc: result.newDoc, result: result.newHeads }
    })
    return newHeads ? encodeHeads(newHeads) : undefined
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
    if (!this.isReady() || !otherHandle.isReady()) {
      throw new Error("Both handles must be ready to merge")
    }
    if (this.#fixedHeads) {
      throw new Error(
        `DocHandle#${this.documentId} is in view-only mode at specific heads. Use clone() to create a new document from this state.`
      )
    }
    const mergingDoc = otherHandle.doc()

    this.#localChangeHandler(doc => {
      return { newDoc: A.merge(doc, mergingDoc) as A.Doc<T>, result: null }
    })
  }

  /** Called by the repo to free memory used by the document. */
  unload() {}

  /** Called by the repo to reuse an unloaded handle. */
  reload() {}

  /** Called by the repo when the document is deleted.
   * @deprecated Use Repo#delete instead
   */
  delete() {
    this.setState("deleted")
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
    return A.stats(this.#doc())
  }
}

//  TYPES

export type SyncInfo = {
  lastHeads: UrlHeads
  lastSyncTimestamp: number
}

/** @hidden */
export type DocHandleOptions<T> =
  // NEW DOCUMENTS
  | {
      /** If we know this is a new document (because we're creating it) this should be set to true. */
      isNew: true

      /** The initial value of the document. */
      initialValue?: T
    }
  // EXISTING DOCUMENTS
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

/**
 * Possible states for a DocHandle
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
