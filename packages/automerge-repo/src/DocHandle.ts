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
   * ├─────────────┤    │ └►├────────────┤ │  or waitForSync()
   * │find()       ├────┘ ┌─┤ REQUESTING │ │
   * ├─────────────┤      │ ├────────────┤ │
   * │create()     ├────┐ │ ├────────────┤ │ via receiveSyncMessage()
   * └─────────────┘    └►└►│ READY      │►┘  or create()
   *                        └────────────┘
   *  ┌───────────────────┐
   *  │value()            │ <- blocks until "ready"
   *  ├───────────────────┤
   *  │provisionalValue() │ <- blocks until "requesting"
   *  └───────────────────┘
   * ```
   *
   * */
  state: HandleState = HandleState.LOADING

  #log: debug.Debugger

  constructor(documentId: DocumentId, newDoc = false) {
    super()
    this.documentId = documentId
    this.#log = debug(`automerge-repo:dochandle:${documentId}`)

    this.doc = A.init({
      patchCallback: (patch, before, after) =>
        this.#emitPatch(patch, before, after),
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
    if (binary.byteLength === 0) return
    this.#log(`[${this.documentId}]: loadIncremental`, this.doc)
    const newDoc = A.loadIncremental(this.doc, binary)
    if (this.state === HandleState.LOADING) {
      this.state = HandleState.READY
      this.emit("ready")
    }
    this.#emitChange(newDoc)
  }

  /**
   * A Repo can call this when it doesn't have the document and has advertised our interest in it.
   * This blocks access to the document until we get it from a peer.
   *
   * TODO: might be good for this to timeout and go to a "not found" state if the document isn't
   * available after a certain amount of time. but not sure what we would do with a doc in that
   * state. We'd also need to retry etc.
   */
  requestSync() {
    if (this.state === HandleState.LOADING) {
      this.state = HandleState.REQUESTING
      this.emit("requesting")
    }
  }

  updateDoc(callback: (doc: Doc<T>) => Doc<T>) {
    this.#log(`updateDoc`, this.doc)
    // TODO: make sure doc is a new version of the old doc somehow...
    const newDoc = callback(this.doc)
    this.#emitChange(newDoc)
  }

  /**
   * We emit a `change` event for the benefit of network and storage; they care about the full
   * history of changes. Changes may or may not result in a patch, would result in something visible
   * to the user.
   */
  #emitChange(newDoc: A.Doc<T>) {
    const oldDoc = this.doc
    this.doc = newDoc

    // we only need to emit a "change" if there actually were changes
    if (!headsAreSame(newDoc, oldDoc)) {
      this.#ready()
      this.emit("change", { handle: this })
    }
  }

  /**
   * We emit a `patch` event for the benefit of the front end; it cares about the changes that might
   * be visible to the user. A patch is the result of one or more changes. It describes the
   * difference between the state before and after the changes.
   */
  #emitPatch(patches: A.Patch[], before: A.Doc<T>, after: A.Doc<T>) {
    this.emit("patch", { handle: this, patches, before, after })
  }

  /**
   * This is the current state of the document. If a document isn't available locally, this will
   * block until until we get it from a peer. (As noted above, we should probably have a timeout.)
   */
  async value() {
    if (!this.isReady()) {
      this.#log(
        `[${this.documentId}]: value: (${this.state}, waiting for ready)`
      )
      await new Promise(resolve => this.once("ready", () => resolve(true)))
    } else {
      await pause()
    }
    this.#log(`[${this.documentId}]: value:`, this.doc)
    return this.doc
  }

  /**
   * If a document isn't available locally, this will return an empty document while we're asking
   * peers for it.
   */
  async provisionalValue() {
    this.#log(`[${this.documentId}]: provisionalValue,`, this.doc)
    if (this.state == HandleState.LOADING) {
      this.#log(
        `[${this.documentId}]: value: (${this.state}, waiting for syncing)`
      )
      await new Promise(resolve => {
        this.once("requesting", () => resolve(true))
        this.once("ready", () => resolve(true))
      })
    } else {
      await pause()
    }
    this.#log(`[${this.documentId}]: provisionalValue:`, this.doc)
    return this.doc
  }

  /** Applies an Automerge change function to the document. */
  async change(callback: A.ChangeFn<T>, options: ChangeOptions<T> = {}) {
    // TODO: we should note that this is blocking to make sure you don't call change() before you get an initial value by accident

    await this.value()
    const newDoc = A.change<T>(this.doc, options, callback)
    this.#log(`change`, { oldDoc: this.doc, newDoc })
    this.#emitChange(newDoc)
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
  patches: A.Patch[]
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
