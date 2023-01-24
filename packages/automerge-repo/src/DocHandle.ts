import * as A from "@automerge/automerge"
import { ChangeOptions, Doc } from "@automerge/automerge"
import debug from "debug"
import EventEmitter from "eventemitter3"
import { eventPromise } from "./helpers/eventPromise.js"
import { headsAreSame } from "./helpers/headsAreSame.js"
import { pause } from "./helpers/pause.js"
import { ChannelId, DocumentId, PeerId } from "./types.js"

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
   * ├─────────────┬─┘  │ ┌┤├────────────┤ │ via load()
   * ├─────────────┤    │ └►├────────────┤ │  or waitForSync()
   * │find()       ├────┘ ┌─┤ REQUESTING │ │
   * ├─────────────┤      │ ├────────────┤ │
   * │create()     ├────┐ │ ├────────────┤ │ via receiveSyncMessage()
   * └─────────────┘    └►└►│ READY      │►┘  or create()
   *                        └────────────┘
   *  ┌────────────┐
   *  │value()     │ <- blocks until "ready"
   *  ├────────────┤
   *  │provisionalValue() │ <- blocks until "syncing"
   *  └────────────┘
   * ```
   *
   * */
  #state: HandleState = HandleState.LOADING

  #log: debug.Debugger

  constructor(documentId: DocumentId, newDoc = false) {
    super()
    this.documentId = documentId
    this.#log = debug(`ar:dochandle:${documentId}`)

    // Create an empty Automerge document
    this.doc = A.init({
      patchCallback: (patch, before, after) => {
        this.#emitPatch(patch, before, after)
      },
    })

    // If this is a freshly created document, we can immediately mark it as ready
    if (newDoc) this.#ready()
  }

  #ready() {
    if (this.#state !== HandleState.READY) {
      this.#state = HandleState.READY
      this.emit("ready")
    }
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
  #emitPatch(patch: A.Patch[], before: A.Doc<T>, after: A.Doc<T>) {
    this.emit("patch", { handle: this, patch, before, after })
  }

  // PUBLIC API

  isReady() {
    return this.#state === HandleState.READY
  }

  /**
   * A Repo can call this when it doesn't have the document and has advertised our interest in it.
   * This blocks access to the document until we get it from a peer.
   *
   * TODO: might be good for this to timeout and go to a "not found" state if the document isn't
   * available after a certain amount of time. but not sure what we would do with a doc in that
   * state. We'd also need to retry etc.
   */
  waitForSync() {
    if (this.#state === HandleState.LOADING) {
      this.#state = HandleState.REQUESTING
    }
  }

  load(doc: A.Doc<T>) {
    this.#log(`load`, this.doc)
    this.#emitChange(doc)
  }

  loadIncremental(binary: Uint8Array) {
    this.#log(`loadIncremental`, this.doc)
    const newDoc = A.loadIncremental(this.doc, binary)
    if (this.#state === HandleState.LOADING) {
      this.#state = HandleState.READY
      this.emit("ready")
    }
    this.#emitChange(newDoc)
  }

  updateDoc(callback: (doc: Doc<T>) => Doc<T>) {
    this.#log(`updateDoc`, this.doc)
    const newDoc = callback(this.doc)
    this.#emitChange(newDoc)
  }

  /**
   * This is the current state of the document. If a document isn't available locally, this will
   * block until until we get it from a peer. (As noted above, this should probably time out after a while.)
   */
  async value(
    /** If we don't have a doc, passing `true` will return an empty doc while we're asking peers for it. */
    provisional = false
  ) {
    if (provisional) {
      // make sure we're not still in loading state
      if (this.#state === HandleState.LOADING) {
        await Promise.any([
          eventPromise(this, "ready"),
          eventPromise(this, "requesting"),
        ])
      }
    } else {
      // wait until we're in ready state
      if (!this.isReady()) {
        await eventPromise(this, "ready")
      } else {
        // HACK: yield for one tick — why do we need this??
        await pause(0)
      }
    }
    return this.doc
  }

  /**
   * Applies an Automerge change function to the document.
   */
  async change(callback: A.ChangeFn<T>, options: ChangeOptions<T> = {}) {
    const oldDoc = await this.value()
    const newDoc = A.change<T>(oldDoc, options, callback)
    this.#log(`change`, { oldDoc: this.doc, newDoc })
    this.#emitChange(newDoc)
  }
}

export const HandleState = {
  /** we're looking for the document on disk */
  LOADING: "LOADING",

  /** we don't have it on disk, we're waiting to see if someone on the network has it **/
  REQUESTING: "REQUESTING",

  /** we have the document in memory  */
  READY: "READY",
} as const
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
  patch: A.Patch[]
  before: A.Doc<T>
  after: A.Doc<T>
}

export interface DocHandleEvents<T> {
  requesting: () => void
  ready: () => void
  message: (payload: DocHandleMessagePayload) => void
  change: (payload: DocHandleChangePayload<T>) => void
  patch: (payload: DocHandlePatchPayload<T>) => void
}
