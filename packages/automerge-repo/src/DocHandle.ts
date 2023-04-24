import * as A from "@automerge/automerge"
import debug from "debug"
import EventEmitter from "eventemitter3"
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
import { waitFor } from "xstate/lib/waitFor"
import { headsAreSame } from "./helpers/headsAreSame"
import { pause } from "./helpers/pause"
import { ChannelId, DocumentId, PeerId } from "./types"

/** DocHandle is a wrapper around a single Automerge document that lets us listen for changes. */
export class DocHandle<T> //
  extends EventEmitter<DocHandleEvents<T>>
{
  #log: debug.Debugger

  #machine: DocHandleXstateMachine<T>
  #timeoutDelay: number

  constructor(
    public documentId: DocumentId,
    { isNew = false, timeoutDelay = 700000 }: DocHandleOptions = {}
  ) {
    super()
    this.#timeoutDelay = timeoutDelay
    this.#log = debug(`automerge-repo:dochandle:${documentId.slice(0, 5)}`)

    // initial doc
    const doc = A.init<T>({
      patchCallback: (patches, { before, after }) =>
        this.emit("patch", { handle: this, patches, before, after }),
    })

    /**
     * Internally we use a state machine to orchestrate document loading and/or syncing, in order to
     * avoid requesting data we already have, or surfacing intermediate values to the consumer.
     *
     *                                                                      ┌─────────┐
     *                                                   ┌─TIMEOUT─────────►│  error  │
     *                      ┌─────────┐           ┌──────┴─────┐            └─────────┘
     *  ┌───────┐  ┌──FIND──┤ loading ├─REQUEST──►│ requesting ├─UPDATE──┐
     *  │ idle  ├──┤        └───┬─────┘           └────────────┘         │
     *  └───────┘  │           LOAD                                      └─►┌─────────┐
     *             │            └──────────────────────────────────────────►│  ready  │
     *             └──CREATE───────────────────────────────────────────────►└─────────┘
     */
    this.#machine = interpret(
      createMachine<DocHandleContext<T>, DocHandleEvent<T>>(
        {
          predictableActionArguments: true,

          id: "docHandle",
          initial: IDLE,
          context: { documentId, doc },
          states: {
            idle: {
              on: {
                // If we're creating a new document, we don't need to load anything
                CREATE: { target: READY },
                // If we're accessing an existing document, we need to request it from storage
                // and/or the network
                FIND: { target: LOADING },
              },
            },
            loading: {
              on: {
                // LOAD is called by the Repo if the document is found in storage
                LOAD: { actions: "onLoad", target: READY },
                // REQUEST is called by the Repo if the document is not found in storage
                REQUEST: { target: REQUESTING },
              },
            },
            requesting: {
              on: {
                // UPDATE is called by the Repo when we receive changes from the network
                UPDATE: { actions: "onUpdate", target: READY },
              },
            },
            ready: {
              on: {
                // UPDATE is called by the Repo when we receive changes from the network
                UPDATE: { actions: "onUpdate", target: READY },
              },
            },
            error: {},
          },
        },

        {
          actions: {
            /** Apply the binary changes from storage and put the updated doc on context */
            onLoad: assign((context, { payload }: LoadEvent) => {
              const { binary } = payload
              const { doc } = context
              const newDoc = A.loadIncremental(doc, binary)
              return { doc: newDoc }
            }),

            /** Put the updated doc on context; if it's different, emit a `change` event */
            onUpdate: assign((context, { payload }: UpdateEvent<T>) => {
              const { doc: oldDoc } = context

              const { callback } = payload
              const newDoc = callback(oldDoc)

              const docChanged = !headsAreSame(newDoc, oldDoc)
              if (docChanged) this.emit("change", { handle: this })
              return { doc: newDoc }
            }),
          },
        }
      )
    )
      .onTransition(({ value: state }, { type: event }) =>
        this.#log(`${event} → ${state}`, this.#doc)
      )
      .start()

    this.#machine.send(isNew ? CREATE : FIND)
  }

  // PRIVATE

  /** Returns the current document */
  get #doc() {
    return this.#machine?.getSnapshot().context.doc
  }

  /** Returns the docHandle's state (READY, ) */
  get #state() {
    return this.#machine?.getSnapshot().value
  }

  #statePromise(state: HandleState) {
    return waitFor(this.#machine, s => s.matches(state))
  }

  // PUBLIC

  isReady = () => this.#state === READY

  /**
   * Returns the current document, waiting for the handle to be ready if necessary.
   */
  async value() {
    await pause() // yield one tick because reasons
    await Promise.race([
      // once we're ready, we can return the document
      this.#statePromise(READY),
      // but if the delay expires and we're still not ready, we'll throw an error
      pause(this.#timeoutDelay),
    ])
    if (!this.isReady())
      throw new Error(`DocHandle timed out loading document ${this.documentId}`)
    return this.#doc
  }

  async loadAttemptedValue() {
    await pause() // yield one tick because reasons
    await Promise.race([
      // once we're ready, we can return the document
      this.#statePromise(REQUESTING),
      this.#statePromise(READY),
      // but if the delay expires and we're still not ready, we'll throw an error
      pause(this.#timeoutDelay),
    ])
    if (!(this.isReady() || this.#state === REQUESTING))
      throw new Error(`DocHandle timed out loading document ${this.documentId}`)
    return this.#doc
  }

  /** `load` is called by the repo when the document is found in storage */
  load(binary: Uint8Array) {
    this.#machine.send(LOAD, { payload: { binary } })
  }

  /** `update` is called by the repo when we receive changes from the network */
  update(callback: (doc: A.Doc<T>) => A.Doc<T>) {
    this.#machine.send(UPDATE, { payload: { callback } })
  }

  /** `change` is called by the repo when the document is changed locally  */
  async change(callback: A.ChangeFn<T>, options: A.ChangeOptions<T> = {}) {
    if (this.#state === LOADING) throw new Error("Cannot change while loading")
    this.#machine.send(UPDATE, {
      payload: {
        callback: (doc: A.Doc<T>) => {
          return A.change(doc, options, callback)
        },
      },
    })
  }

  /** `request` is called by the repo when the document is not found in storage */
  request() {
    if (this.#state === LOADING) this.#machine.send(REQUEST)
  }
}

// WRAPPER CLASS TYPES

interface DocHandleOptions {
  isNew?: boolean
  timeoutDelay?: number
}

export interface DocHandleMessagePayload {
  destinationId: PeerId
  channelId: ChannelId
  data: Uint8Array
}

export interface DocHandleChangePayload<T> {
  handle: DocHandle<T>
}

export interface DocHandlePatchPayload<T> {
  handle: DocHandle<T>
  patches: A.Patch[]
  before: A.Doc<T>
  after: A.Doc<T>
}

export interface DocHandleEvents<T> {
  change: (payload: DocHandleChangePayload<T>) => void
  patch: (payload: DocHandlePatchPayload<T>) => void
}

// STATE MACHINE TYPES

// state

export const HandleState = {
  IDLE: "idle",
  LOADING: "loading",
  REQUESTING: "requesting",
  READY: "ready",
  ERROR: "error",
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
  documentId: string
  doc: A.Doc<T>
}

// events

export const Event = {
  CREATE: "CREATE",
  LOAD: "LOAD",
  FIND: "FIND",
  REQUEST: "REQUEST",
  UPDATE: "UPDATE",
  TIMEOUT: "TIMEOUT",
} as const
type Event = (typeof Event)[keyof typeof Event]

type CreateEvent = { type: typeof CREATE; payload: { documentId: string } }
type LoadEvent = { type: typeof LOAD; payload: { binary: Uint8Array } }
type FindEvent = { type: typeof FIND; payload: { documentId: string } }
type RequestEvent = { type: typeof REQUEST }
type UpdateEvent<T> = {
  type: typeof UPDATE
  payload: { callback: (doc: A.Doc<T>) => A.Doc<T> }
}
type TimeoutEvent = { type: typeof TIMEOUT }

type DocHandleEvent<T> =
  | CreateEvent
  | LoadEvent
  | FindEvent
  | RequestEvent
  | UpdateEvent<T>
  | TimeoutEvent

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

const { IDLE, LOADING, REQUESTING, READY, ERROR } = HandleState
const { CREATE, LOAD, FIND, REQUEST, UPDATE, TIMEOUT } = Event
