import * as A from "@automerge/automerge/next"
import debug from "debug"
import { EventEmitter } from "eventemitter3"
import {
  assign,
  BaseActionObject,
  createMachine,
  interpret,
  Interpreter,
  ResolveTypegenMeta,
  ServiceMap,
  StateSchema,
  StateValue,
  TypegenDisabled,
} from "xstate"
import { waitFor } from "xstate/lib/waitFor.js"
import { headsAreSame } from "./helpers/headsAreSame.js"
import { pause } from "./helpers/pause.js"
import { TimeoutError, withTimeout } from "./helpers/withTimeout.js"
import type { DocumentId, PeerId, AutomergeUrl } from "./types.js"
import { stringifyAutomergeUrl } from "./DocUrl.js"
import { encode } from "./helpers/cbor.js"

/** DocHandle is a wrapper around a single Automerge document that lets us
 * listen for changes and notify the network and storage of new changes.
 *
 * @remarks
 * A `DocHandle` represents a document which is being managed by a {@link Repo}.
 * To obtain `DocHandle` use {@link Repo.find} or {@link Repo.create}.
 *
 * To modify the underlying document use either {@link DocHandle.change} or
 * {@link DocHandle.changeAt}. These methods will notify the `Repo` that some
 * change has occured and the `Repo` will save any new changes to the
 * attached {@link StorageAdapter} and send sync messages to connected peers.
 * */
export class DocHandle<T> //
  extends EventEmitter<DocHandleEvents<T>>
{
  #log: debug.Debugger

  #machine: DocHandleXstateMachine<T>
  #timeoutDelay: number

  /** The URL of this document
   *
   * @remarks
   * This can be used to request the document from an instance of {@link Repo}
   */
  get url(): AutomergeUrl {
    return stringifyAutomergeUrl({ documentId: this.documentId })
  }

  /** @hidden */
  constructor(
    public documentId: DocumentId,
    { isNew = false, timeoutDelay = 60_000 }: DocHandleOptions = {}
  ) {
    super()
    this.#timeoutDelay = timeoutDelay
    this.#log = debug(`automerge-repo:dochandle:${this.documentId.slice(0, 5)}`)

    // initial doc
    let doc = A.init<T>()

    // Make an empty change so that we have something to save to disk
    if (isNew) {
      doc = A.emptyChange(doc, {})
    }

    /**
     * Internally we use a state machine to orchestrate document loading and/or syncing, in order to
     * avoid requesting data we already have, or surfacing intermediate values to the consumer.
     *
     *                          ┌─────────────────────┬─────────TIMEOUT────►┌────────┐
     *                      ┌───┴─────┐           ┌───┴────────┐            │ failed │
     *  ┌───────┐  ┌──FIND──┤ loading ├─REQUEST──►│ requesting ├─UPDATE──┐  └────────┘
     *  │ idle  ├──┤        └───┬─────┘           └────────────┘         │
     *  └───────┘  │            │                                        └─►┌────────┐
     *             │            └───────LOAD───────────────────────────────►│ ready  │
     *             └──CREATE───────────────────────────────────────────────►└────────┘
     */
    this.#machine = interpret(
      createMachine<DocHandleContext<T>, DocHandleEvent<T>>(
        {
          predictableActionArguments: true,

          id: "docHandle",
          initial: IDLE,
          context: {
            documentId: this.documentId,
            doc,
            currentHeads: A.getHeads(doc),
            lastPatches: [],
            beforeDoc: doc,
            beforeHeads: A.getHeads(doc),
          },
          states: {
            idle: {
              on: {
                // If we're creating a new document, we don't need to load anything
                CREATE: { target: READY },
                // If we're accessing an existing document, we need to request it from storage
                // and/or the network
                FIND: { target: LOADING },
                DELETE: { actions: "onDelete", target: DELETED },
              },
            },
            loading: {
              on: {
                // UPDATE is called by the Repo if the document is found in storage
                UPDATE: { actions: "onUpdate", target: READY },
                // REQUEST is called by the Repo if the document is not found in storage
                REQUEST: { target: REQUESTING },
                // AWAIT_NETWORK is called by the repo if the document is not found in storage but the network is not yet ready
                AWAIT_NETWORK: { target: AWAITING_NETWORK },
                DELETE: { actions: "onDelete", target: DELETED },
              },
              after: [
                {
                  delay: this.#timeoutDelay,
                  target: FAILED,
                },
              ],
            },
            awaitingNetwork: {
              on: {
                NETWORK_READY: { target: REQUESTING },
              },
            },
            requesting: {
              on: {
                MARK_UNAVAILABLE: {
                  target: UNAVAILABLE,
                  actions: "onUnavailable",
                },
                // UPDATE is called by the Repo when we receive changes from the network
                UPDATE: { actions: "onUpdate" },
                // REQUEST_COMPLETE is called from `onUpdate` when the doc has been fully loaded from the network
                REQUEST_COMPLETE: { target: READY },
                DELETE: { actions: "onDelete", target: DELETED },
              },
              after: [
                {
                  delay: this.#timeoutDelay,
                  target: FAILED,
                },
              ],
            },
            ready: {
              on: {
                // UPDATE is called by the Repo when we receive changes from the network
                UPDATE: { actions: "onUpdate", target: READY },
                DELETE: { actions: "onDelete", target: DELETED },
              },
            },
            failed: {
              type: "final",
            },
            deleted: {
              type: "final",
            },
            unavailable: {
              on: {
                UPDATE: { actions: "onUpdate" },
                // REQUEST_COMPLETE is called from `onUpdate` when the doc has been fully loaded from the network
                REQUEST_COMPLETE: { target: READY },
                DELETE: { actions: "onDelete", target: DELETED },
              },
            },
          },
        },

        {
          actions: {
            /** Put the updated doc on context */
            onUpdate: assign((context, { payload }: UpdateEvent<T>) => {
              const { doc: oldDoc } = context

              const { callback } = payload
              const changes = callback(oldDoc)

              console.log(changes)

              const { patches, patchInfo } = changes

              return { doc: patchInfo.after }
            }),
            onDelete: assign(() => {
              this.emit("delete", { handle: this })
              return { doc: undefined }
            }),
            onUnavailable: assign(context => {
              const { doc } = context

              this.emit("unavailable", { handle: this })
              return { doc }
            }),
          },
        }
      )
    )
      .onTransition(({ value: state, history, context }, event) => {
        const oldDoc = history?.context?.doc
        const newDoc = context.doc

        this.#log(`${history?.value}: ${event.type} → ${state}`, newDoc)

        const docChanged =
          newDoc &&
          oldDoc &&
          !headsAreSame(A.getHeads(newDoc), A.getHeads(oldDoc))
        if (docChanged) {
          this.emit("heads-changed", { handle: this, doc: newDoc })

          const patches = A.diff(newDoc, A.getHeads(oldDoc), A.getHeads(newDoc))
          if (patches.length > 0) {
            const source = "change" // TODO: pass along the source (load/change/network)
            this.emit("change", {
              handle: this,
              doc: newDoc,
              patches,
              patchInfo: { before: oldDoc, after: newDoc, source },
            })
          }

          if (!this.isReady()) {
            this.#machine.send(REQUEST_COMPLETE)
          }
        }
      })
      .start()

    this.#machine.send(isNew ? CREATE : FIND)
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
    if (!Array.isArray(awaitStates)) awaitStates = [awaitStates]
    return Promise.any(
      awaitStates.map(state =>
        waitFor(this.#machine, s => s.matches(state), {
          timeout: this.#timeoutDelay * 2000, // longer than the delay above for testing
        })
      )
    )
  }

  // PUBLIC

  /**
   * Checks if the document is ready for accessing or changes.
   * Note that for documents already stored locally this occurs before synchronization
   * with any peers. We do not currently have an equivalent `whenSynced()`.
   */
  isReady = () => this.inState([HandleState.READY])
  /**
   * Checks if this document has been marked as deleted.
   * Deleted documents are removed from local storage and the sync process.
   * It's not currently possible at runtime to undelete a document.
   * @returns true if the document has been marked as deleted
   */
  isDeleted = () => this.inState([HandleState.DELETED])
  isUnavailable = () => this.inState([HandleState.UNAVAILABLE])
  inState = (states: HandleState[]) =>
    states.some(this.#machine?.getSnapshot().matches)

  /** @hidden */
  get state() {
    return this.#machine?.getSnapshot().value
  }

  /**
   * Use this to block until the document handle has finished loading.
   * The async equivalent to checking `inState()`.
   * @param awaitStates = [READY]
   * @returns
   */
  async whenReady(awaitStates: HandleState[] = [READY]): Promise<void> {
    await withTimeout(this.#statePromise(awaitStates), this.#timeoutDelay)
  }

  /**
   * Returns the current state of the Automerge document this handle manages.
   * Note that this waits for the handle to be ready if necessary, and currently, if
   * loading (or synchronization) fails, will never resolve.
   *
   * @param {awaitStates=[READY]} optional states to wait for, such as "LOADING". mostly for internal use.
   */
  async doc(
    awaitStates: HandleState[] = [READY, UNAVAILABLE]
  ): Promise<A.Doc<T> | undefined> {
    await pause() // yield one tick because reasons
    try {
      // wait for the document to enter one of the desired states
      await this.#statePromise(awaitStates)
    } catch (error) {
      if (error instanceof TimeoutError)
        throw new Error(`DocHandle: timed out loading ${this.documentId}`)
      else throw error
    }
    // Return the document
    return !this.isUnavailable() ? this.#doc : undefined
  }

  /**
   * Returns the current state of the Automerge document this handle manages, or undefined.
   * Useful in a synchronous context. Consider using `await handle.doc()` instead, check `isReady()`,
   * or use `whenReady()` if you want to make sure loading is complete first.
   *
   * Do not confuse this with the SyncState of the document, which describes the state of the synchronization process.
   *
   * Note that `undefined` is not a valid Automerge document so the return from this function is unambigous.
   * @returns the current document, or undefined if the document is not ready
   */
  docSync(): A.Doc<T> | undefined {
    if (!this.isReady()) {
      return undefined
    }

    return this.#doc
  }

  /** `update` is called by the repo when we receive changes from the network
   * @hidden
   * */
  update(callback: UpdateEvent<T>["payload"]["callback"]) {
    this.#machine.send(UPDATE, {
      payload: { callback },
    })
  }

  /** `change` is called by the repo when the document is changed locally  */
  change(callback: A.ChangeFn<T>, options: A.ChangeOptions<T> = {}) {
    if (!this.isReady()) {
      throw new Error(
        `DocHandle#${this.documentId} is not ready. Check \`handle.isReady()\` before accessing the document.`
      )
    }
    this.update((doc: A.Doc<T>) => {
      let patches: A.Patch[]
      let patchInfo: A.PatchInfo<T>
      const originalCallback = options.patchCallback
      options = {
        ...options,
        patchCallback: (p, pInfo) => {
          patches = p
          patchInfo = pInfo

          if (originalCallback) {
            originalCallback(p, pInfo)
          }
        },
      }
      A.change(doc, options, callback)

      return {
        patches: patches!,
        patchInfo: patchInfo!,
      }
    })
  }

  /** Make a change as if the document were at `heads`
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
    let resultHeads: A.Heads | undefined = undefined

    this.update((doc: A.Doc<T>) => {
      let patches: A.Patch[]
      let patchInfo: A.PatchInfo<T>

      const originalCallback = options.patchCallback
      options = {
        ...options,
        patchCallback: (p, pInfo) => {
          patches = p
          patchInfo = pInfo

          if (originalCallback) {
            originalCallback(p, pInfo)
          }
        },
      }

      const result = A.changeAt(doc, heads, options, callback)
      resultHeads = result.newHeads

      return {
        patches: patches!,
        patchInfo: patchInfo!,
      }
    })
    return resultHeads
  }

  /** Merge another document into this document
   *
   * @param otherHandle - the handle of the document to merge into this one
   *
   * @remarks
   * This is a convenience method for
   * `handle.change(doc => A.merge(doc, otherHandle.docSync()))`. Any peers
   * whom we are sharing changes with will be notified of the changes resulting
   * from the merge.
   *
   * @throws if either document is not ready or if `otherHandle` is unavailable (`otherHandle.docSync() === undefined`)
   */
  merge(otherHandle: DocHandle<T>) {
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

  unavailable() {
    this.#machine.send(MARK_UNAVAILABLE)
  }

  /** `request` is called by the repo when the document is not found in storage
   * @hidden
   * */
  request() {
    if (this.#state === LOADING) this.#machine.send(REQUEST)
  }

  /** @hidden */
  awaitNetwork() {
    if (this.#state === LOADING) this.#machine.send(AWAIT_NETWORK)
  }

  /** @hidden */
  networkReady() {
    if (this.#state === AWAITING_NETWORK) this.#machine.send(NETWORK_READY)
  }

  /** `delete` is called by the repo when the document is deleted */
  delete() {
    this.#machine.send(DELETE)
  }

  /** `broadcast` sends an arbitrary ephemeral message out to all reachable peers who would receive sync messages from you
   * it has no guarantee of delivery, and is not persisted to the underlying automerge doc in any way.
   * messages will have a sending PeerId but this is *not* a useful user identifier.
   * a user could have multiple tabs open and would appear as multiple PeerIds.
   * every message source must have a unique PeerId.
   */
  broadcast(message: any) {
    this.emit("ephemeral-message-outbound", {
      handle: this,
      data: encode(message),
    })
  }
}

// WRAPPER CLASS TYPES

/** @hidden */
export interface DocHandleOptions {
  isNew?: boolean
  timeoutDelay?: number
}

export interface DocHandleMessagePayload {
  destinationId: PeerId
  documentId: DocumentId
  data: Uint8Array
}

export interface DocHandleEncodedChangePayload<T> {
  handle: DocHandle<T>
  doc: A.Doc<T>
}

export interface DocHandleDeletePayload<T> {
  handle: DocHandle<T>
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

export interface DocHandleEphemeralMessagePayload {
  handle: DocHandle<any>
  senderId: PeerId
  message: unknown
}

export interface DocHandleOutboundEphemeralMessagePayload {
  handle: DocHandle<any>
  data: Uint8Array
}

export interface DocHandleEvents<T> {
  "heads-changed": (payload: DocHandleEncodedChangePayload<T>) => void
  change: (payload: DocHandleChangePayload<T>) => void
  delete: (payload: DocHandleDeletePayload<T>) => void
  unavailable: (payload: DocHandleDeletePayload<T>) => void
  "ephemeral-message": (payload: DocHandleEphemeralMessagePayload) => void
  "ephemeral-message-outbound": (
    payload: DocHandleOutboundEphemeralMessagePayload
  ) => void
}

// STATE MACHINE TYPES

// state

/**
 * The state of a document handle
 * @enum
 *
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
  /** We were unable to load or request the document for some reason */
  FAILED: "failed",
  /** The document has been deleted from the repo */
  DELETED: "deleted",
  /** The document was not available in storage or from any connected peers */
  UNAVAILABLE: "unavailable",
} as const
export type HandleState = (typeof HandleState)[keyof typeof HandleState]

type DocHandleMachineState = {
  states: Record<
    (typeof HandleState)[keyof typeof HandleState],
    StateSchema<HandleState>
  >
}

// context

interface DocHandleContext<T> {
  documentId: DocumentId
  doc: A.Doc<T>
  lastPatches: A.Patch[]
  beforeDoc: A.Doc<T>
  beforeHeads: A.Heads
  currentHeads: A.Heads
}

// events

export const Event = {
  CREATE: "CREATE",
  FIND: "FIND",
  REQUEST: "REQUEST",
  REQUEST_COMPLETE: "REQUEST_COMPLETE",
  AWAIT_NETWORK: "AWAIT_NETWORK",
  NETWORK_READY: "NETWORK_READY",
  UPDATE: "UPDATE",
  TIMEOUT: "TIMEOUT",
  DELETE: "DELETE",
  MARK_UNAVAILABLE: "MARK_UNAVAILABLE",
} as const
type Event = (typeof Event)[keyof typeof Event]

type CreateEvent = { type: typeof CREATE; payload: { documentId: string } }
type FindEvent = { type: typeof FIND; payload: { documentId: string } }
type RequestEvent = { type: typeof REQUEST }
type RequestCompleteEvent = { type: typeof REQUEST_COMPLETE }
type DeleteEvent = { type: typeof DELETE }
type UpdateEvent<T> = {
  type: typeof UPDATE
  payload: {
    callback: (doc: A.Doc<T>) => {
      patches: A.Patch[]
      patchInfo: {
        before?: A.Doc<T>
        after: A.Doc<T>
        source: "load" | "clone" | A.PatchSource
      }
    }
  }
}
type TimeoutEvent = { type: typeof TIMEOUT }
type MarkUnavailableEvent = { type: typeof MARK_UNAVAILABLE }
type AwaitNetworkEvent = { type: typeof AWAIT_NETWORK }
type NetworkReadyEvent = { type: typeof NETWORK_READY }

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

type DocHandleXstateMachine<T> = Interpreter<
  DocHandleContext<T>,
  DocHandleMachineState,
  DocHandleEvent<T>,
  {
    value: StateValue // Should this be unknown or T?
    context: DocHandleContext<T>
  },
  ResolveTypegenMeta<
    TypegenDisabled,
    DocHandleEvent<T>,
    BaseActionObject,
    ServiceMap
  >
>

// CONSTANTS
export const {
  IDLE,
  LOADING,
  AWAITING_NETWORK,
  REQUESTING,
  READY,
  FAILED,
  DELETED,
  UNAVAILABLE,
} = HandleState
const {
  CREATE,
  FIND,
  REQUEST,
  UPDATE,
  TIMEOUT,
  DELETE,
  REQUEST_COMPLETE,
  MARK_UNAVAILABLE,
  AWAIT_NETWORK,
  NETWORK_READY,
} = Event
