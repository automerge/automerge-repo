import * as A from "@automerge/automerge/slim/next"
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
          const doc = callback(oldDoc)
          return { doc }
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
      /** @xstate-layout N4IgpgJg5mDOIC5QAoC2BDAxgCwJYDswBKAYgFUAFAEQEEAVAUQG0AGAXUVAAcB7WXAC64e+TiAAeiAOwAOAKwA6ACxSAzKqks1ATjlTdAGhABPRAFolAJksKN2y1KtKAbFLla5AX09G0WPISkVAwAMgyMrBxIILz8QiJikggAjCzOijKqLEqqybJyLizaRqYIFpbJtro5Uo7J2o5S3r4YOATECrgQADZgJADCAEoM9MzsYrGCwqLRSeoyCtra8pa5adquySXmDjY5ac7JljLJeepKzSB+bYGdPX0AYgCSAHJUkRN8UwmziM7HCgqyVcUnqcmScmcMm2ZV2yiyzkOx1OalUFx8V1aAQ63R46AgBCgJGGAEUyAwAMp0D7RSbxGagJKHFgKOSWJTJGRSCosCpKaEmRCqbQKU5yXINeTaer6LwY67YogKXH4wkkKgAeX6AH1hjQqABNGncL70xKIJQ5RY5BHOJag6wwpRyEWImQVeT1aWrVSXBXtJUqgn4Ik0ADqNCedG1L3CYY1gwA0saYqbpuaEG4pKLksKpFDgcsCjDhTnxTKpTLdH6sQGFOgAO7oKYhl5gAQNngAJwA1iRY3R40ndSNDSm6enfpm5BkWAVkvy7bpuTCKq7ndZnfVeSwuTX-HWu2AAI4AVzgQhD6q12rILxoADVIyEaAAhMLjtM-RmIE4LVSQi4nLLDIGzOCWwLKA0cgyLBoFWNy+43B0R5nheaqajqepjuMtJfgyEh-FoixqMCoKqOyhzgYKCDOq6UIeuCSxHOoSGKgop74OgABuzbdOgABGvTXlho5GrhJpxJOP4pLulT6KoMhpJY2hzsWNF0QobqMV6LG+pc+A8BAcBiP6gSfFJ36EQgKksksKxrHamwwmY7gLKB85QjBzoAWxdZdL0FnfARST8ooLC7qoTnWBU4pyC5ViVMKBQaHUDQuM4fm3EGhJBWaU7-CysEAUp3LpEpWw0WYRw2LmqzgqciIsCxWUdI2zaXlAbYdt2PZ5dJ1n5jY2iJY1ikOIcMJHCyUWHC62hRZkUVNPKta3Kh56wJ1-VWUyzhFc64JWJCtQNBBzhQW4cHwbsrVKpxPF8YJgV4ZZIWIKkiKiiNSkqZYWjzCWaQ5hFh0AcCuR3QoR74qUknBRmzholpv3OkpRQNNRpTzaKTWKbIWR5FDxm9AIkA7e9skUYCWayLILBZGoLkUSKbIyIdpxHPoyTeN4QA */

      // You can use the XState extension for VS Code to visualize this machine.
      // Or, you can see this static visualization (last updated April 2024): https://stately.ai/registry/editor/d7af9b58-c518-44f1-9c36-92a238b04a7a?machineId=91c387e7-0f01-42c9-a21d-293e9bf95bb7

      initial: "idle",
      context: { documentId, doc },
      on: {
        UPDATE: { actions: "onUpdate" },
        DELETE: ".deleted",
      },
      states: {
        idle: {
          on: {
            CREATE: "ready",
            FIND: "loading",
          },
        },
        loading: {
          on: {
            REQUEST: "requesting",
            DOC_READY: "ready",
            AWAIT_NETWORK: "awaitingNetwork",
          },
          after: { [delay]: "unavailable" },
        },
        awaitingNetwork: {
          on: { NETWORK_READY: "requesting" },
        },
        requesting: {
          on: {
            DOC_UNAVAILABLE: "unavailable",
            DOC_READY: "ready",
          },
          after: { [delay]: "unavailable" },
        },
        unavailable: {
          entry: "onUnavailable",
          on: { DOC_READY: "ready" },
        },
        ready: {},
        deleted: { entry: "onDelete", type: "final" },
      },
    })

    // Instantiate the state machine
    this.#machine = createActor(machine)

    // Listen for state transitions
    this.#machine.subscribe(state => {
      const before = this.#prevDocState
      const after = state.context.doc
      this.#log(`→ ${state.value} %o`, after)
      // if the document has changed, emit a change event
      this.#checkForChanges(before, after)
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
  #checkForChanges(before: T | undefined, after: T) {
    const docChanged =
      after && before && !headsAreSame(A.getHeads(after), A.getHeads(before))
    if (docChanged) {
      this.emit("heads-changed", { handle: this, doc: after })

      const patches = A.diff(after, A.getHeads(before), A.getHeads(after))
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
      if (!this.isReady()) this.#machine.send({ type: DOC_READY })
    }
    this.#prevDocState = after
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
  async whenReady(awaitStates: HandleState[] = ["ready"]) {
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
  ) {
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
  docSync() {
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

    // the callback above will always run before we get here, so this should always contain the new heads
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
      throw new Error("The document to be merged in is falsy, aborting.")
    }

    this.update(doc => {
      return A.merge(doc, mergingDoc)
    })
  }

  /**
   * Used in testing to mark this document as unavailable.
   * @hidden
   */
  unavailable() {
    this.#machine.send({ type: DOC_UNAVAILABLE })
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
  heads: A.Heads
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

/** These are the (internal) events that can be sent to the state machine */
type DocHandleEvent<T> =
  | { type: typeof CREATE }
  | { type: typeof FIND }
  | { type: typeof REQUEST }
  | { type: typeof DOC_READY }
  | {
      type: typeof UPDATE
      payload: { callback: (doc: A.Doc<T>) => A.Doc<T> }
    }
  | { type: typeof TIMEOUT }
  | { type: typeof DELETE }
  | { type: typeof DOC_UNAVAILABLE }
  | { type: typeof AWAIT_NETWORK }
  | { type: typeof NETWORK_READY }

const CREATE = "CREATE"
const FIND = "FIND"
const REQUEST = "REQUEST"
const DOC_READY = "DOC_READY"
const AWAIT_NETWORK = "AWAIT_NETWORK"
const NETWORK_READY = "NETWORK_READY"
const UPDATE = "UPDATE"
const DELETE = "DELETE"
const TIMEOUT = "TIMEOUT"
const DOC_UNAVAILABLE = "DOC_UNAVAILABLE"
