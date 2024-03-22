import * as A from "@automerge/automerge/next"
import debug from "debug"
import { EventEmitter } from "eventemitter3"
import { assertEvent, assign, createActor, setup, waitFor } from "xstate"
import { stringifyAutomergeUrl } from "./AutomergeUrl.js"
import { encode } from "./helpers/cbor.js"
import { headsAreSame } from "./helpers/headsAreSame.js"
import { withTimeout } from "./helpers/withTimeout.js"
import type { AutomergeUrl, DocumentId, PeerId } from "./types.js"
import { StorageId } from "./storage/types.js"

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

  /** The XState actor running our state machine.  */
  #machine

  /** The last known state of our document. */
  #prevDocState: T | undefined

  /** How long to wait before giving up on a document. (Note that a document will be marked
   * unavailable much sooner if all known peers respond that they don't have it.) */
  #timeoutDelay = 60_000

  /** A dictionary mapping each peer to the last heads we know they have. */
  #remoteHeads: Record<StorageId, A.Heads> = {}

  /** @hidden */
  constructor(
    public documentId: DocumentId,
    options: DocHandleOptions<T> = {}
  ) {
    super()

    if ("timeoutDelay" in options && options.timeoutDelay) {
      this.#timeoutDelay = options.timeoutDelay
    }

    let doc: T
    const isNew = "isNew" in options && options.isNew
    if (isNew) {
      // T should really be constrained to extend `Record<string, unknown>` (an automerge doc can't be
      // e.g. a primitive, an array, etc. - it must be an object). But adding that constraint creates
      // a bunch of other problems elsewhere so for now we'll just cast it here to make Automerge happy.
      doc = A.from(options.initialValue as Record<string, unknown>) as T
      doc = A.emptyChange<T>(doc)
    } else {
      doc = A.init<T>()
    }

    this.#log = debug(`automerge-repo:dochandle:${this.documentId.slice(0, 5)}`)

    const delay = this.#timeoutDelay
    const machine = setup({
      types: {
        context: {} as DocHandleContext<T>,
        events: {} as DocHandleEvent<T>,
      },
      actions: {
        /** Update the doc using the given callback and put the modified doc in context */
        onUpdate: assign(({ context, event }) => {
          const oldDoc = context.doc

          assertEvent(event, UPDATE)
          const { callback } = event.payload
          const newDoc = callback(oldDoc)

          return { doc: newDoc }
        }),
        onDelete: assign(() => {
          this.emit("delete", { handle: this })
          return { doc: undefined }
        }),
        onUnavailable: () => {
          this.emit("unavailable", { handle: this })
        },
      },
    }).createMachine({
      initial: "idle",
      context: { documentId, doc },
      on: {
        UPDATE: { actions: "onUpdate" },
        DELETE: { target: ".deleted" },
      },
      states: {
        idle: {
          on: {
            CREATE: { target: "ready" },
            FIND: { target: "loading" },
          },
        },
        loading: {
          on: {
            UPDATE: { actions: "onUpdate", target: "ready" },
            REQUEST: { target: "requesting" },
            AWAIT_NETWORK: { target: "awaitingNetwork" },
          },
          after: { [delay]: { target: "unavailable" } },
        },
        awaitingNetwork: {
          on: {
            NETWORK_READY: { target: "requesting" },
          },
        },
        requesting: {
          on: {
            MARK_UNAVAILABLE: { target: "unavailable" },
            REQUEST_COMPLETE: { target: "ready" },
          },
          after: { [delay]: { target: "unavailable" } },
        },
        unavailable: {
          entry: "onUnavailable",
          on: {
            REQUEST_COMPLETE: { target: "ready" },
          },
        },
        ready: {},
        deleted: {
          entry: "onDelete",
          type: "final",
        },
      },
    })

    // Instantiate the state machine
    this.#machine = createActor(machine)

    // Listen for state transitions
    this.#machine.subscribe(state => {
      const oldDoc = this.#prevDocState
      const newDoc = state.context.doc
      this.#log(`→ ${state.value} %o`, newDoc)
      // if the document has changed, emit a change event
      this.#checkForChanges(oldDoc, newDoc)
    })

    // Start the machine, and send a create or find event to get things going
    this.#machine.start()
    this.#machine.send(isNew ? { type: CREATE } : { type: FIND })
  }

  // PRIVATE

  /** Returns the current document, regardless of state */
  get #doc() {
    return this.#machine?.getSnapshot().context.doc
  }

  /** Returns the docHandle's state (READY, etc.) */
  get #state() {
    return this.#machine?.getSnapshot().value
  }

  /** Returns a promise that resolves when the docHandle is in one of the given states */
  #statePromise(awaitStates: HandleState | HandleState[]) {
    const awaitStatesArray = Array.isArray(awaitStates)
      ? awaitStates
      : [awaitStates]
    return waitFor(
      this.#machine,
      s => awaitStatesArray.some(state => s.matches(state)),
      // use a longer delay here so as not to race with other delays
      { timeout: this.#timeoutDelay * 2 }
    )
  }

  /**
   * Called after state transitions. If the document has changed, emits a change event. If we just
   * received the document for the first time, signal that our request has been completed.
   */
  #checkForChanges(oldDoc: T | undefined, newDoc: T) {
    const docChanged =
      newDoc && oldDoc && !headsAreSame(A.getHeads(newDoc), A.getHeads(oldDoc))
    if (docChanged) {
      this.emit("heads-changed", { handle: this, doc: newDoc })

      const patches = A.diff(newDoc, A.getHeads(oldDoc), A.getHeads(newDoc))
      if (patches.length > 0) {
        this.emit("change", {
          handle: this,
          doc: newDoc,
          patches,
          patchInfo: {
            before: oldDoc,
            after: newDoc,
            source: "change", // TODO: pass along the source (load/change/network)
          },
        })
      }

      // If we didn't have the document yet, signal that we now do
      if (!this.isReady()) this.#machine.send({ type: REQUEST_COMPLETE })
    }
    this.#prevDocState = newDoc
  }

  // PUBLIC

  /** Our documentId in Automerge URL form.
   */
  get url(): AutomergeUrl {
    return stringifyAutomergeUrl({ documentId: this.documentId })
  }

  /**
   * @returns true if the document is ready for accessing or changes.
   *
   * Note that for documents already stored locally this occurs before synchronization with any
   * peers. We do not currently have an equivalent `whenSynced()`.
   */
  isReady = () => this.inState(["ready"])

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
  inState = (states: HandleState[]) =>
    states.some(s => this.#machine.getSnapshot().matches(s))

  /** @hidden */
  get state() {
    return this.#machine.getSnapshot().value
  }

  /**
   * @returns a promise that resolves when the document is in one of the given states (if no states
   * are passed, when the document is ready)
   *
   * Use this to block until the document handle has finished loading. The async equivalent to
   * checking `inState()`.
   */
  async whenReady(awaitStates: HandleState[] = ["ready"]): Promise<void> {
    await withTimeout(this.#statePromise(awaitStates), this.#timeoutDelay)
  }

  /**
   * @returns the current state of this handle's Automerge document.
   *
   * This is the recommended way to access a handle's document. Note that this waits for the handle
   * to be ready if necessary. If loading (or synchronization) fails, this will never resolve.
   */
  async doc(
    /** states to wait for, such as "LOADING". mostly for internal use. */
    awaitStates: HandleState[] = ["ready", "unavailable"]
  ): Promise<A.Doc<T> | undefined> {
    try {
      // wait for the document to enter one of the desired states
      await this.#statePromise(awaitStates)
    } catch (error) {
      // if we timed out, return undefined
      return undefined
    }
    // Return the document
    return !this.isUnavailable() ? this.#doc : undefined
  }

  /**
   * Synchronously returns the current state of the Automerge document this handle manages, or
   * undefined. Consider using `await handle.doc()` instead. Check `isReady()`, or use `whenReady()`
   * if you want to make sure loading is complete first.
   *
   * Not to be confused with the SyncState of the document, which describes the state of the
   * synchronization process.
   *
   * Note that `undefined` is not a valid Automerge document, so the return from this function is
   * unambigous.
   *
   * @returns the current document, or undefined if the document is not ready.
   */
  docSync(): A.Doc<T> | undefined {
    if (!this.isReady()) return undefined
    else return this.#doc
  }

  /**
   * Returns the current "heads" of the document, akin to a git commit.
   * This precisely defines the state of a document.
   * @returns the current document's heads, or undefined if the document is not ready
   */
  heads(): A.Heads | undefined {
    if (!this.isReady()) {
      return undefined
    }
    return A.getHeads(this.#doc)
  }

  /** 
   * `update` is called by the repo when we receive changes from the network
   * Called by the repo when we receive changes from the network.
   * @hidden
   */
  update(callback: (doc: A.Doc<T>) => A.Doc<T>) {
    this.#machine.send({ type: UPDATE, payload: { callback } })
  }

  /**
   * Called by the repo either when a doc handle changes or we receive new remote heads.
   * @hidden
   */
  setRemoteHeads(storageId: StorageId, heads: A.Heads) {
    this.#remoteHeads[storageId] = heads
    this.emit("remote-heads", { storageId, heads })
  }

  /** Returns the heads of the storageId. */
  getRemoteHeads(storageId: StorageId): A.Heads | undefined {
    return this.#remoteHeads[storageId]
  }

  /** Called by the repo when the document is changed locally.  */
  change(callback: A.ChangeFn<T>, options: A.ChangeOptions<T> = {}) {
    if (!this.isReady()) {
      throw new Error(
        `DocHandle#${this.documentId} is not ready. Check \`handle.isReady()\` before accessing the document.`
      )
    }
    this.#machine.send({
      type: UPDATE,
      payload: { callback: doc => A.change(doc, options, callback) },
    })
  }

  /**
   * Makes a change as if the document were at `heads`.
   *
   * @returns A set of heads representing the concurrent change that was made.
   */
  changeAt(
    heads: A.Heads,
    callback: A.ChangeFn<T>,
    options: A.ChangeOptions<T> = {}
  ): string[] | undefined {
    if (!this.isReady()) {
      throw new Error(
        `DocHandle#${this.documentId} is not ready. Check \`handle.isReady()\` before accessing the document.`
      )
    }
    let resultHeads: string[] | undefined = undefined
    this.#machine.send({
      type: UPDATE,
      payload: {
        callback: doc => {
          const result = A.changeAt(doc, heads, options, callback)
          resultHeads = result.newHeads || undefined
          return result.newDoc
        },
      },
    })
    return resultHeads
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
    const mergingDoc = otherHandle.docSync()
    if (!mergingDoc) {
      throw new Error("The document to be merged in is null, aborting.")
    }

    this.update(doc => {
      return A.merge(doc, mergingDoc)
    })
  }

  /** Marks this document as unavailable. */
  unavailable() {
    this.#machine.send({ type: MARK_UNAVAILABLE })
  }

  /** Called by the repo when the document is not found in storage.
   * @hidden
   * */
  request() {
    if (this.#state === "loading") this.#machine.send({ type: REQUEST })
  }

  /** @hidden */
  awaitNetwork() {
    if (this.#state === "loading") this.#machine.send({ type: AWAIT_NETWORK })
  }

  /** @hidden */
  networkReady() {
    if (this.#state === "awaitingNetwork")
      this.#machine.send({ type: NETWORK_READY })
  }

  /** Called by the repo when the document is deleted. */
  delete() {
    this.#machine.send({ type: DELETE })
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
      data: encode(message),
    })
  }
}

//  TYPES

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

      /** The number of milliseconds before we mark this document as unavailable if we don't have it and nobody shares it with us. */
      timeoutDelay?: number
    }

// EXTERNAL EVENTS

/** These are the events that this DocHandle emits to external listeners */
export interface DocHandleEvents<T> {
  "heads-changed": (payload: DocHandleEncodedChangePayload<T>) => void
  change: (payload: DocHandleChangePayload<T>) => void
  delete: (payload: DocHandleDeletePayload<T>) => void
  unavailable: (payload: DocHandleUnavailablePayload<T>) => void
  "ephemeral-message": (payload: DocHandleEphemeralMessagePayload<T>) => void
  "ephemeral-message-outbound": (
    payload: DocHandleOutboundEphemeralMessagePayload<T>
  ) => void
  "remote-heads": (payload: DocHandleRemoteHeadsPayload) => void
}

export interface DocHandleEncodedChangePayload<T> {
  handle: DocHandle<T>
  doc: A.Doc<T>
}

/** Emitted when a document has changed */
export interface DocHandleChangePayload<T> {
  /** The hande which changed */
  handle: DocHandle<T>
  /** The value of the document after the change */
  doc: A.Doc<T>
  /** The patches representing the change that occurred */
  patches: A.Patch[]
  /** Information about the change */
  patchInfo: A.PatchInfo<T>
}

export interface DocHandleDeletePayload<T> {
  handle: DocHandle<T>
}

export interface DocHandleUnavailablePayload<T> {
  handle: DocHandle<T>
}

export interface DocHandleEphemeralMessagePayload<T> {
  handle: DocHandle<T>
  senderId: PeerId
  message: unknown
}

export interface DocHandleOutboundEphemeralMessagePayload<T> {
  handle: DocHandle<T>
  data: Uint8Array
}

export interface DocHandleRemoteHeadsPayload {
  storageId: StorageId
  heads: A.Heads
}

// STATE MACHINE TYPES & CONSTANTS

// state

/**
 * Possible internal states of a handle
 */
export const HandleState = {
  /** The handle has been created but not yet loaded or requested */
  IDLE: "idle",
  /** We are waiting for storage to finish loading */
  LOADING: "loading",
  /** We are waiting for the network to be come ready */
  AWAITING_NETWORK: "awaitingNetwork",
  /** We are waiting for someone in the network to respond to a sync request */
  REQUESTING: "requesting",
  /** The document is available */
  READY: "ready",
  /** The document has been deleted from the repo */
  DELETED: "deleted",
  /** The document was not available in storage or from any connected peers */
  UNAVAILABLE: "unavailable",
} as const
export type HandleState = (typeof HandleState)[keyof typeof HandleState]

export const {
  IDLE,
  LOADING,
  AWAITING_NETWORK,
  REQUESTING,
  READY,
  DELETED,
  UNAVAILABLE,
} = HandleState

// context

interface DocHandleContext<T> {
  documentId: DocumentId
  doc: A.Doc<T>
}

// events

/** These are the events that the state machine handles internally */
type DocHandleEvent<T> =
  | CreateEvent
  | FindEvent
  | RequestEvent
  | RequestCompleteEvent
  | UpdateEvent<T>
  | TimeoutEvent
  | DeleteEvent
  | MarkUnavailableEvent
  | AwaitNetworkEvent
  | NetworkReadyEvent

type CreateEvent = { type: "CREATE" }
type FindEvent = { type: "FIND" }
type RequestEvent = { type: "REQUEST" }
type RequestCompleteEvent = { type: "REQUEST_COMPLETE" }
type DeleteEvent = { type: "DELETE" }
type UpdateEvent<T> = { type: "UPDATE"; payload: { callback: Callback<T> } }
type TimeoutEvent = { type: "TIMEOUT" }
type MarkUnavailableEvent = { type: "MARK_UNAVAILABLE" }
type AwaitNetworkEvent = { type: "AWAIT_NETWORK" }
type NetworkReadyEvent = { type: "NETWORK_READY" }

type Callback<T> = (doc: A.Doc<T>) => A.Doc<T>

const CREATE = "CREATE"
const FIND = "FIND"
const REQUEST = "REQUEST"
const REQUEST_COMPLETE = "REQUEST_COMPLETE"
const AWAIT_NETWORK = "AWAIT_NETWORK"
const NETWORK_READY = "NETWORK_READY"
const UPDATE = "UPDATE"
const DELETE = "DELETE"
const MARK_UNAVAILABLE = "MARK_UNAVAILABLE"
