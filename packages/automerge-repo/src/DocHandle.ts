import { next as A } from "@automerge/automerge/slim"
import debug from "debug"
import { EventEmitter } from "eventemitter3"
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
import {
  AbortError,
  AbortOptions,
  isAbortErrorLike,
} from "./helpers/abortable.js"

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

  /** Current state of the state machine */
  #currentState: HandleState = IDLE

  /** The current document */
  #doc: A.Doc<T>

  /** Timeout handle for state transitions */
  #timeoutHandle?: ReturnType<typeof setTimeout>

  /** Listeners for state changes (used by #statePromise) */
  #stateListeners: Set<(state: HandleState) => void> = new Set()

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

  /** @hidden */
  constructor(
    public documentId: DocumentId,
    options: DocHandleOptions<T> = {}
  ) {
    super()

    if ("timeoutDelay" in options && options.timeoutDelay) {
      this.#timeoutDelay = options.timeoutDelay
    }

    if ("heads" in options) {
      this.#fixedHeads = options.heads
    }

    this.#doc = A.init<T>()

    this.#log = debug(`automerge-repo:dochandle:${this.documentId.slice(0, 5)}`)

    // Start the machine, and send a create or find event to get things going
    this.begin()
  }

  // PRIVATE

  /**
   * Transition to a new state with proper cleanup and entry actions
   */
  #transition(newState: HandleState) {
    // Clear any pending timeout when transitioning
    this.#clearTimeout()

    this.#currentState = newState

    // Log the state transition
    this.#log(`→ ${newState} %o`, this.#doc)

    // Entry actions for certain states
    switch (newState) {
      case UNAVAILABLE:
        this.#doc = A.init()
        this.#prevDocState = this.#doc as unknown as T
        break
      case UNLOADED:
        this.#doc = A.init()
        this.#prevDocState = this.#doc as unknown as T
        break
      case DELETED:
        this.emit("delete", { handle: this })
        this.#doc = A.init()
        this.#prevDocState = this.#doc as unknown as T
        break
      case LOADING:
      case REQUESTING:
        // Set up timeout for loading/requesting states
        this.#setupTimeout()
        break
    }

    // Notify any state listeners
    for (const listener of this.#stateListeners) {
      listener(newState)
    }
  }

  /**
   * Set up a timeout that transitions to unavailable state
   */
  #setupTimeout() {
    this.#timeoutHandle = setTimeout(() => {
      if (this.#currentState === LOADING || this.#currentState === REQUESTING) {
        this.#transition(UNAVAILABLE)
      }
    }, this.#timeoutDelay)
  }

  /**
   * Clear the timeout if set
   */
  #clearTimeout() {
    if (this.#timeoutHandle) {
      clearTimeout(this.#timeoutHandle)
      this.#timeoutHandle = undefined
    }
  }

  /**
   * Process an event and transition to a new state if appropriate
   */
  #send(event: DocHandleEventType) {
    const before = this.#prevDocState
    const current = this.#currentState

    switch (event) {
      case BEGIN:
        if (current === IDLE) {
          this.#transition(LOADING)
        }
        break

      case REQUEST:
        if (current === LOADING) {
          this.#transition(REQUESTING)
        }
        break

      case DOC_READY:
        if (
          current === LOADING ||
          current === REQUESTING ||
          current === UNAVAILABLE
        ) {
          this.#transition(READY)
        }
        break

      case DOC_UNAVAILABLE:
        if (current === REQUESTING) {
          this.#transition(UNAVAILABLE)
        }
        break

      case UNLOAD:
        // Can unload from any state except deleted
        if (current !== DELETED) {
          this.#transition(UNLOADED)
        }
        break

      case RELOAD:
        if (current === UNLOADED) {
          this.#transition(LOADING)
        }
        break

      case DELETE:
        // Can delete from any state
        this.#transition(DELETED)
        break
    }
  }

  /**
   * Returns a promise that resolves when the docHandle is in one of the given states
   *
   * @param awaitStates - HandleState or HandleStates to wait for
   * @param signal - Optional AbortSignal to cancel the waiting operation
   */
  #statePromise(
    awaitStates: HandleState | HandleState[],
    options?: AbortOptions
  ): Promise<void> {
    const awaitStatesArray = Array.isArray(awaitStates)
      ? awaitStates
      : [awaitStates]

    // If already in the desired state, resolve immediately
    if (awaitStatesArray.includes(this.#currentState)) {
      return Promise.resolve()
    }

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.#stateListeners.delete(listener)
        reject(new Error("Timeout waiting for state"))
      }, this.#timeoutDelay * 2)

      // Handle abort signal
      if (options?.signal) {
        if (options.signal.aborted) {
          clearTimeout(timeoutId)
          reject(new AbortError())
          return
        }
        options.signal.addEventListener("abort", () => {
          clearTimeout(timeoutId)
          this.#stateListeners.delete(listener)
          reject(new AbortError())
        })
      }

      const listener = (state: HandleState) => {
        if (awaitStatesArray.includes(state)) {
          clearTimeout(timeoutId)
          this.#stateListeners.delete(listener)
          resolve()
        }
      }

      this.#stateListeners.add(listener)
    })
  }

  /**
   * Update the document with whatever the result of callback is
   */
  #sendUpdate(callback: (doc: A.Doc<T>) => A.Doc<T>) {
    const before = this.#prevDocState
    let thrownException: null | Error = null

    try {
      this.#doc = callback(this.#doc)
    } catch (e) {
      thrownException = e as Error
    }

    // Check for changes after update
    this.#checkForChanges(before, this.#doc)

    if (thrownException) {
      // If the callback threw an error, we throw it here so the caller can handle it
      throw thrownException
    }
  }

  /**
   * Called after state transitions. If the document has changed, emits a change event. If we just
   * received the document for the first time, signal that our request has been completed.
   */
  #checkForChanges(before: A.Doc<T>, after: A.Doc<T>) {
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

      // If we didn't have the document yet, signal that we now do
      if (!this.isReady()) this.#send(DOC_READY)
    }
    this.#prevDocState = after
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
  inState = (states: HandleState[]) => states.includes(this.#currentState)

  /** @hidden */
  get state() {
    return this.#currentState
  }

  /**
   * Returns promise that resolves when document is in one of the given states (default is 'ready' state)
   *
   * Use this to block until the document handle has finished loading. The async equivalent to
   * checking `inState()`.
   *
   * @param awaitStates - HandleState or HandleStates to wait for
   * @param signal - Optional AbortSignal to cancel the waiting operation
   * @returns a promise that resolves when the document is in one of the given states (if no states
   * are passed, when the document is ready)
   */
  async whenReady(
    awaitStates: HandleState[] = ["ready"],
    options?: AbortOptions
  ) {
    try {
      await withTimeout(
        this.#statePromise(awaitStates, options),
        this.#timeoutDelay
      )
    } catch (error) {
      if (isAbortErrorLike(error)) {
        throw new AbortError() //throw new error for stack trace
      }
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
  doc() {
    if (!this.isReady()) throw new Error("DocHandle is not ready")
    if (this.#fixedHeads) {
      return A.view(this.#doc, decodeHeads(this.#fixedHeads))
    }
    return this.#doc
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
    return encodeHeads(A.getHeads(this.#doc))
  }

  begin() {
    this.#send(BEGIN)
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
    const handle = new DocHandle<T>(this.documentId, {
      heads,
      timeoutDelay: this.#timeoutDelay,
    })
    handle.update(() => A.clone(this.#doc))
    handle.doneLoading()

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

    const doc = this.#doc
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
    this.#sendUpdate(callback)
  }

  /**
   * `doneLoading` is called by the repo after it decides it has all the changes
   * it's going to get during setup. This might mean it was created locally,
   * or that it was loaded from storage, or that it was received from a peer.
   */
  doneLoading() {
    this.#send(DOC_READY)
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
        `DocHandle#${this.documentId} is in ${this.state} and not ready. Check \`handle.isReady()\` before accessing the document.`
      )
    }

    if (this.#fixedHeads) {
      throw new Error(
        `DocHandle#${this.documentId} is in view-only mode at specific heads. Use clone() to create a new document from this state.`
      )
    }

    this.#sendUpdate(doc => A.change(doc, options, callback))
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

    let resultHeads: UrlHeads | undefined = undefined
    this.#sendUpdate(doc => {
      const result = A.changeAt(doc, decodeHeads(heads), options, callback)
      resultHeads = result.newHeads ? encodeHeads(result.newHeads) : undefined
      return result.newDoc
    })

    // the callback above will always run before we get here, so this should always contain the new heads
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
    if (!this.isReady() || !otherHandle.isReady()) {
      throw new Error("Both handles must be ready to merge")
    }
    if (this.#fixedHeads) {
      throw new Error(
        `DocHandle#${this.documentId} is in view-only mode at specific heads. Use clone() to create a new document from this state.`
      )
    }
    const mergingDoc = otherHandle.doc()

    this.update(doc => {
      return A.merge(doc, mergingDoc)
    })
  }

  /**
   * Updates the internal state machine to mark the document unavailable.
   * @hidden
   */
  unavailable() {
    this.#send(DOC_UNAVAILABLE)
  }

  /**
   * Called by the repo either when the document is not found in storage.
   * @hidden
   * */
  request() {
    if (this.#currentState === LOADING) this.#send(REQUEST)
  }

  /** Called by the repo to free memory used by the document. */
  unload() {
    this.#send(UNLOAD)
  }

  /** Called by the repo to reuse an unloaded handle. */
  reload() {
    this.#send(RELOAD)
  }

  /** Called by the repo when the document is deleted. */
  delete() {
    this.#send(DELETE)
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

// events

/** Internal event types that can be sent to the state machine */
type DocHandleEventType =
  | typeof BEGIN
  | typeof REQUEST
  | typeof DOC_READY
  | typeof UNLOAD
  | typeof RELOAD
  | typeof DELETE
  | typeof DOC_UNAVAILABLE

const BEGIN = "BEGIN"
const REQUEST = "REQUEST"
const DOC_READY = "DOC_READY"
const UNLOAD = "UNLOAD"
const RELOAD = "RELOAD"
const DELETE = "DELETE"
const DOC_UNAVAILABLE = "DOC_UNAVAILABLE"
