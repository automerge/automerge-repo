import EventEmitter from "eventemitter3"
import * as Automerge from "@automerge/automerge"
import { Doc } from "@automerge/automerge"
import { ChannelId, PeerId } from "."

import debug from "debug"
const log = debug("DocHandle")

export type DocumentId = string & { __documentId: true }

type HandleState = "loading" | "syncing" | "ready"
/*
 * Handle Lifecycle
 * We need to carefully orchestrate document loading in order
 * to avoid requesting data we already have or surfacing intermediate
 * values to the consumer above.
 *
 *                        handle.state
 * ┌───────────────┐      ┌─────────┐
 * │new DocHandle()│  ┌──►│ loading ├─┐
 * ├─────────────┬─┘  │ ┌┤├─────────┤ │ via loadIncremental()
 * ├─────────────┤    │ └►├─────────┤ │  or unblockSync()
 * │find()       ├────┘ ┌─┤ syncing │ │
 * ├─────────────┤      │ ├─────────┤ │
 * │create()     ├────┐ │ ├─────────┤ │ via receiveSyncMessage()
 * └─────────────┘    └►└►│ ready   │►┘  or create()
 *                        └─────────┘
 *  ┌────────────┐
 *  │value()     │ <- blocks until "ready"
 *  ├────────────┤
 *  │syncValue() │ <- blocks until "syncing"
 *  └────────────┘
 *
 */

/**
 * DocHandle is a wrapper around a single Automerge document that allows us to listen for changes.
 */
export class DocHandle<T> extends EventEmitter<DocHandleEvents<T>> {
  doc: Automerge.Doc<T>
  documentId: DocumentId
  state: HandleState = "loading"

  constructor(documentId: DocumentId, newDoc = false) {
    super()
    this.documentId = documentId
    this.doc = Automerge.init({
      patchCallback: (
        patch: any, // Automerge.Patch,
        before: Automerge.Doc<T>,
        after: Automerge.Doc<T>
      ) => this.__notifyPatchListeners(patch, before, after),
    })

    // new documents don't need to block on an initial value setting
    if (newDoc) {
      this.state = "ready"
      this.emit("ready")
    }
  }

  ready() {
    return this.state === "ready"
  }

  loadIncremental(binary: Uint8Array) {
    log(`[${this.documentId}]: loadIncremental`, this.doc)
    const newDoc = Automerge.loadIncremental(this.doc, binary)
    if (this.state === "loading") {
      this.state = "ready"
      this.emit("ready")
    }
    this.__notifyChangeListeners(newDoc)
  }

  unblockSync() {
    if (this.state === "loading") {
      this.state = "syncing"
      this.emit("syncing")
    }
  }

  updateDoc(callback: (doc: Doc<T>) => Doc<T>) {
    log(`[${this.documentId}]: updateDoc`, this.doc)
    // make sure doc is a new version of the old doc somehow...
    this.__notifyChangeListeners(callback(this.doc))
  }

  __notifyChangeListeners(newDoc: Automerge.Doc<T>) {
    if ("then" in newDoc) {
      throw new Error("this appears to be a promise")
    }

    const oldDoc = this.doc
    this.doc = newDoc

    const equalArrays = (a: unknown[], b: unknown[]) =>
      a.length === b.length && a.every((element, index) => element === b[index])

    // we only need to emit a "change" if something changed as a result of the update
    if (!equalArrays(Automerge.getHeads(newDoc), Automerge.getHeads(oldDoc))) {
      if (this.state != "ready") {
        // only go to ready once
        this.state = "ready"
        this.emit("ready")
      }
      this.emit("change", {
        handle: this,
      })
    }
  }

  __notifyPatchListeners(
    patch: any, //Automerge.Patch,
    before: Automerge.Doc<T>,
    after: Automerge.Doc<T>
  ) {
    this.emit("patch", { handle: this, patch, before, after })
  }

  async value() {
    if (!this.ready()) {
      log(`[${this.documentId}]: value: (${this.state}, waiting for ready)`)
      await new Promise((resolve) => this.once("ready", () => resolve(true)))
    } else {
      await new Promise((resolve) => setTimeout(() => resolve(true), 0))
    }
    log(`[${this.documentId}]: value:`, this.doc)
    return this.doc
  }

  // this returns the value but not until after loading is done
  // but it will return the value during syncing when we don't want to share it
  // with the frontend / user code
  async syncValue() {
    log(`[${this.documentId}]: syncValue,`, this.doc)
    if (this.state == "loading") {
      log(`[${this.documentId}]: value: (${this.state}, waiting for syncing)`)
      await new Promise((resolve) => this.once("syncing", () => resolve(true)))
    } else {
      await new Promise((resolve) => setTimeout(() => resolve(true), 0))
    }
    log(`[${this.documentId}]: syncValue:`, this.doc)
    return this.doc
  }

  change(callback: (doc: T) => void) {
    this.value().then(() => {
      const newDoc = Automerge.change<T>(this.doc, callback)
      this.__notifyChangeListeners(newDoc)
    })
  }
}

export interface DocHandleMessageEvent {
  destinationId: PeerId
  channelId: ChannelId
  data: Uint8Array
}

export interface DocHandleChangeEvent<T> {
  handle: DocHandle<T>
}

export interface DocHandlePatchEvent<T> {
  handle: DocHandle<T>
  patch: any // Automerge.Patch
  before: Automerge.Doc<T>
  after: Automerge.Doc<T>
}

export interface DocHandleEvents<T> {
  syncing: () => void // HMM
  ready: () => void // HMM
  message: (event: DocHandleMessageEvent) => void
  change: (event: DocHandleChangeEvent<T>) => void
  patch: (event: DocHandlePatchEvent<T>) => void
}
