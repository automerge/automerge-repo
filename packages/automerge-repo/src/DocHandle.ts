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
  TypegenDisabled,
} from "xstate"
import { headsAreSame } from "./helpers/headsAreSame"
import { pause } from "./helpers/pause"
import { ChannelId, DocumentId, PeerId } from "./types"

export class DocHandle<T> //
  extends EventEmitter<DocHandleEvents<T>>
{
  #log: debug.Debugger

  #machine: DocHandleXstateMachine<T>

  constructor(public documentId: DocumentId, isNew: boolean = false) {
    super()
    this.#log = debug(`automerge-repo:dochandle:${documentId.slice(0, 5)}`)

    // initial doc
    const doc = A.init<T>({
      patchCallback: (patches, before, after) =>
        this.emit("patch", { handle: this, patches, before, after }),
    })

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
                CREATE: { target: READY },
                FIND: { target: LOADING },
              },
            },
            loading: {
              on: {
                LOAD: { actions: "onLoad", target: READY },
                UPDATE: { actions: "onUpdate", target: READY },
                REQUEST: { target: REQUESTING },
              },
            },
            requesting: {
              on: {
                UPDATE: { actions: "onUpdate", target: READY },
              },
              after: {
                [TIMEOUT_DELAY]: { actions: "failTimeout", target: ERROR },
              },
            },
            ready: {
              on: {
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
              const { doc: newDoc } = payload
              const docChanged = !headsAreSame(newDoc, oldDoc)
              if (docChanged) this.emit("change", { handle: this })
              return { doc: newDoc }
            }),

            failTimeout: _ => {},
          },
        }
      )
    )
      .onTransition(({ value: state }, { type: event }) =>
        this.#log(`${event} → ${state}`, this.doc)
      )
      .start()

    this.#machine.send(isNew ? CREATE : FIND)
  }

  // PUBLIC

  get doc() {
    return this.#machine?.getSnapshot().context.doc || ({} as A.Doc<T>)
  }

  get state() {
    return this.#machine?.getSnapshot().value as HandleState
  }

  isReady() {
    return this.state === READY
  }

  async value(waitForState: HandleState[] = [READY]) {
    if (waitForState.includes(this.state)) await pause()
    else
      await new Promise<void>(async resolve =>
        this.#machine.onTransition(() => {
          if (waitForState.includes(this.state)) resolve()
        })
      )
    return this.#machine.getSnapshot().context.doc
  }

  async provisionalValue() {
    return this.value([READY, REQUESTING])
  }

  async loadIncremental(binary: Uint8Array) {
    this.#machine.send(LOAD, { payload: { binary } })
  }

  updateDoc(callback: (doc: A.Doc<T>) => A.Doc<T>) {
    const newDoc = callback(this.doc)
    this.#machine.send(UPDATE, { payload: { doc: newDoc } })
  }

  async change(callback: A.ChangeFn<T>, options: A.ChangeOptions<T> = {}) {
    const doc = await this.value()
    const newDoc = A.change(doc, options, callback)
    this.#machine.send(UPDATE, { payload: { doc: newDoc } })
  }

  requestSync() {
    if (this.state === LOADING) this.#machine.send(REQUEST)
  }
}

// TYPES

export const HandleState = {
  IDLE: "idle",
  LOADING: "loading",
  REQUESTING: "requesting",
  READY: "ready",
  ERROR: "error",
} as const
export type HandleState = (typeof HandleState)[keyof typeof HandleState]

type DocHandleMachineState = {
  states: Record<(typeof HandleState)[keyof typeof HandleState], {}>
}

interface DocHandleContext<T> {
  documentId: string
  doc: A.Doc<T>
}

export const Event = {
  CREATE: "CREATE",
  LOAD: "LOAD",
  FIND: "FIND",
  REQUEST: "REQUEST",
  UPDATE: "UPDATE",
  TIMEOUT: "TIMEOUT",
} as const
type Event = (typeof Event)[keyof typeof Event]

type CreateEvent = {
  type: typeof CREATE
  payload: { documentId: string }
}

type LoadEvent = {
  type: typeof LOAD
  payload: { binary: Uint8Array }
}

type FindEvent = {
  type: typeof FIND
  payload: { documentId: string }
}

type RequestEvent = {
  type: typeof REQUEST
}

type UpdateEvent<T> = {
  type: typeof UPDATE
  payload: { doc: A.Doc<T> }
}

type TimeoutEvent = {
  type: typeof TIMEOUT
}

type DocHandleEvent<T> =
  | CreateEvent
  | LoadEvent
  | FindEvent
  | RequestEvent
  | UpdateEvent<T>
  | TimeoutEvent

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

type DocHandleXstateMachine<T> = Interpreter<
  DocHandleContext<T>,
  DocHandleMachineState,
  DocHandleEvent<T>,
  {
    value: any
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

const TIMEOUT_DELAY = 7000
const { IDLE, LOADING, REQUESTING, READY, ERROR } = HandleState
const { CREATE, LOAD, FIND, REQUEST, UPDATE, TIMEOUT } = Event
