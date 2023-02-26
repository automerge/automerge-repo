import * as A from "@automerge/automerge"
import { ChangeOptions, Doc } from "@automerge/automerge"
import debug from "debug"
import EventEmitter from "eventemitter3"
import { headsAreSame } from "./helpers/headsAreSame"
import { pause } from "./helpers/pause"
import { ChannelId, DocumentId, PeerId } from "./types"

/** DocHandle is a wrapper around a single Automerge document that lets us listen for changes. */
export class DocHandle<T = unknown> extends EventEmitter<DocHandleEvents<T>> {
  doc: A.Doc<T>
  documentId: DocumentId

  /**
   * We need to carefully orchestrate document loading in order to avoid requesting data we already
   * have or surfacing intermediate values to the consumer. The handle lifecycle looks like this:
   * ```
   *                        handle.state
   * ┌───────────────┐      ┌────────────┐
   * │new DocHandle()│  ┌──►│ LOADING    ├─┐
   * ├─────────────┬─┘  │ ┌┤├────────────┤ │ via loadIncremental()
   * ├─────────────┤    │ └►├────────────┤ │  or unblockSync()
   * │find()       ├────┘ ┌─┤ REQUESTING │ │
   * ├─────────────┤      │ ├────────────┤ │
   * │create()     ├────┐ │ ├────────────┤ │ via receiveSyncMessage()
   * └─────────────┘    └►└►│ READY      │►┘  or create()
   *                        └────────────┘
   *  ┌────────────┐
   *  │value()     │ <- blocks until "ready"
   *  ├────────────┤
   *  │provisionalValue() │ <- blocks until "requesting"
   *  └────────────┘
   * ```
   *
   * */
  state: HandleState = HandleState.LOADING

  #log: debug.Debugger

  constructor(documentId: DocumentId, newDoc = false) {
    super()
    this.documentId = documentId
    this.#log = debug(`ar:dochandle:${documentId}`)

    this.doc = A.init({
      patchCallback: (patch, before, after) =>
        this.#notifyPatchListeners(patch, before, after),
    })

    // If this is a freshly created document, we can immediately mark it as ready
    if (newDoc) this.#ready()
  }

  #ready() {
    if (this.state !== HandleState.READY) {
      this.state = HandleState.READY
      this.emit("ready")
    }
  }

  isReady() {
    return this.state === HandleState.READY
  }

  loadIncremental(binary: Uint8Array) {
    this.#log(`[${this.documentId}]: loadIncremental`, this.doc)
    const newDoc = A.loadIncremental(this.doc, binary)
    if (this.state === HandleState.LOADING) {
      this.state = HandleState.READY
      this.emit("ready")
    }
    this.#notifyChangeListeners(newDoc)
  }

  request() {
    if (this.state === HandleState.LOADING) {
      this.state = HandleState.REQUESTING
      this.emit("requesting")
    }
  }

  updateDoc(callback: (doc: Doc<T>) => Doc<T>) {
    this.#log(`[${this.documentId}]: updateDoc`, this.doc)
    // make sure doc is a new version of the old doc somehow...
    this.#notifyChangeListeners(callback(this.doc))
  }

  #notifyChangeListeners(newDoc: A.Doc<T>) {
    const oldDoc = this.doc
    this.doc = newDoc

    // we only need to emit a "change" if there actually were changes
    if (!headsAreSame(newDoc, oldDoc)) {
      this.#ready()
      this.emit("change", { handle: this })
    }
  }

  #notifyPatchListeners(
    patch: any, //Automerge.Patch,
    before: A.Doc<T>,
    after: A.Doc<T>
  ) {
    this.emit("patch", { handle: this, patch, before, after })
  }

  async value() {
    if (!this.isReady()) {
      this.#log(
        `[${this.documentId}]: value: (${this.state}, waiting for ready)`
      )
      await new Promise(resolve => this.once("ready", () => resolve(true)))
    } else {
      await pause(0)
    }
    this.#log(`[${this.documentId}]: value:`, this.doc)
    return this.doc
  }

  /**
   * syncValue returns the value, but not until after loading is done. It will return the value
   * during syncing when we don't want to share it with the frontend/user code.
   */
  async syncValue() {
    this.#log(`[${this.documentId}]: syncValue,`, this.doc)
    if (this.state == HandleState.LOADING) {
      this.#log(
        `[${this.documentId}]: value: (${this.state}, waiting for syncing)`
      )
      await new Promise(resolve => {
        this.once("requesting", () => resolve(true))
        this.once("ready", () => resolve(true))
      })
    } else {
      await pause(0)
    }
    this.#log(`[${this.documentId}]: syncValue:`, this.doc)
    return this.doc
  }

  change(callback: (doc: T) => void, options: ChangeOptions<T> = {}) {
    this.value().then(() => {
      const newDoc = A.change<T>(this.doc, options, callback)
      this.#notifyChangeListeners(newDoc)
    })
  }
}

export const HandleState = {
  /** we're looking for the document on disk */
  LOADING: "LOADING",
  /** we don't have it on disk, we're asking the network **/
  REQUESTING: "REQUESTING",
  /** we have the document in memory  */
  READY: "READY",
} as const

// avoiding enum https://maxheiber.medium.com/alternatives-to-typescript-enums-50e4c16600b1
export type HandleState = typeof HandleState[keyof typeof HandleState]

// types

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
  patch: A.Patch
  before: A.Doc<T>
  after: A.Doc<T>
}

export interface DocHandleEvents<T> {
  requesting: () => void // HMM
  ready: () => void // HMM
  message: (payload: DocHandleMessagePayload) => void
  change: (payload: DocHandleChangePayload<T>) => void
  patch: (payload: DocHandlePatchPayload<T>) => void
}
