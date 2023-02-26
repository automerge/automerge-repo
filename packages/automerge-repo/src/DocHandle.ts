import * as A from "@automerge/automerge"
import { ChangeOptions, Doc } from "@automerge/automerge"
import EventEmitter from "eventemitter3"
import { ChannelId, DocumentId, PeerId } from "./types"

import debug from "debug"
const log = debug("ar:dochandle")

/** DocHandle is a wrapper around a single Automerge document that lets us listen for changes. */
export class DocHandle<T = unknown> extends EventEmitter<DocHandleEvents<T>> {
  doc: A.Doc<T>
  documentId: DocumentId
  state: HandleState = HandleState.LOADING

  constructor(documentId: DocumentId, newDoc = false) {
    super()
    this.documentId = documentId
    this.doc = A.init({
      patchCallback: (patch, before, after) =>
        this.#notifyPatchListeners(patch, before, after),
    })

    // new documents don't need to block on an initial value setting
    if (newDoc) {
      this.state = HandleState.READY
      this.emit("ready")
    }
  }

  isReady() {
    return this.state === HandleState.READY
  }

  loadIncremental(binary: Uint8Array) {
    log(`[${this.documentId}]: loadIncremental`, this.doc)
    const newDoc = A.loadIncremental(this.doc, binary)
    if (this.state === HandleState.LOADING) {
      this.state = HandleState.READY
      this.emit("ready")
    }
    this.#notifyChangeListeners(newDoc)
  }

  requestDocument() {
    if (this.state === HandleState.LOADING) {
      this.state = HandleState.REQUESTING
      this.emit("syncing")
    }
  }

  updateDoc(callback: (doc: Doc<T>) => Doc<T>) {
    log(`[${this.documentId}]: updateDoc`, this.doc)
    // make sure doc is a new version of the old doc somehow...
    this.#notifyChangeListeners(callback(this.doc))
  }

  #notifyChangeListeners(newDoc: A.Doc<T>) {
    const oldDoc = this.doc
    this.doc = newDoc

    const equalArrays = (a: unknown[], b: unknown[]) =>
      a.length === b.length && a.every((element, index) => element === b[index])

    // we only need to emit a "change" if something changed as a result of the update
    if (!equalArrays(A.getHeads(newDoc), A.getHeads(oldDoc))) {
      if (this.state !== HandleState.READY) {
        // only go to ready once
        this.state = HandleState.READY
        this.emit("ready")
      }
      this.emit("change", {
        handle: this,
      })
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
      log(`[${this.documentId}]: value: (${this.state}, waiting for ready)`)
      await new Promise(resolve => this.once("ready", () => resolve(true)))
    } else {
      await new Promise(resolve => setTimeout(() => resolve(true), 0))
    }
    log(`[${this.documentId}]: value:`, this.doc)
    return this.doc
  }

  /**
   * syncValue returns the value, but not until after loading is done. It will return the value
   * during syncing when we don't want to share it with the frontend/user code.
   */
  async syncValue() {
    log(`[${this.documentId}]: syncValue,`, this.doc)
    if (this.state == HandleState.LOADING) {
      log(`[${this.documentId}]: value: (${this.state}, waiting for syncing)`)
      await new Promise(resolve => {
        this.once("syncing", () => resolve(true))
        this.once("ready", () => resolve(true))
      })
    } else {
      await new Promise(resolve => setTimeout(() => resolve(true), 0))
    }
    log(`[${this.documentId}]: syncValue:`, this.doc)
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
  syncing: () => void // HMM
  ready: () => void // HMM
  message: (payload: DocHandleMessagePayload) => void
  change: (payload: DocHandleChangePayload<T>) => void
  patch: (payload: DocHandlePatchPayload<T>) => void
}
