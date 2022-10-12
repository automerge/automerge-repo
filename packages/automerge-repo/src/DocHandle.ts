import EventEmitter from "eventemitter3"
import * as Automerge from "@automerge/automerge"
import { Doc } from "@automerge/automerge"

export type DocumentId = string & { __documentId: true }

/**
 * DocHandle is a wrapper around a single Automerge document that allows us to listen for changes.
 */
export class DocHandle<T> extends EventEmitter<DocHandleEvents<T>> {
  doc: Automerge.Doc<T>
  documentId: DocumentId
  anyChangeHappened = false // TODO: wait until we have the whole doc

  // TODO: DocHandle is kind of terrible because we have to be careful to preserve a 1:1
  // relationship between handles and documentIds or else we have split-brain on listeners.
  // It would be easier just to have one repo object to pass around but that means giving
  // total repo access to everything which seems gratuitous to me.

  constructor(documentId: DocumentId, newDoc = false) {
    super()
    if (!documentId) {
      throw new Error("Need a document ID for this DocHandle.")
    }
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
      this.anyChangeHappened = true
    }
  }

  ready() {
    return this.anyChangeHappened === true
  }

  updateDoc(callback: (doc: Doc<T>) => Doc<T>) {
    // make sure doc is a new version of the old doc somehow...
    this.__notifyChangeListeners(callback(this.doc))
  }

  __notifyChangeListeners(newDoc: Automerge.Doc<T>) {
    this.anyChangeHappened = true
    this.doc = newDoc

    this.emit("change", {
      handle: this,
    })
  }

  __notifyPatchListeners(
    patch: any, //Automerge.Patch,
    before: Automerge.Doc<T>,
    after: Automerge.Doc<T>
  ) {
    // @ts-ignore-next-line
    this.emit("patch", { handle: this, patch, before, after })
  }

  async value() {
    if (!this.ready()) {
      await new Promise((resolve) => this.once("change", () => resolve(true)))
    }
    return this.doc
  }

  // A handy convenience method but not strictly required...
  change(callback: (doc: T) => void) {
    this.value().then((doc) => {
      const newDoc = Automerge.change<T>(doc, callback)
      this.__notifyChangeListeners(newDoc)
    })
  }
}

export interface DocHandleChangeEvent<T> {
  handle: DocHandle<T>
}

export interface DocHandlePatchEvent<T> {
  handle: DocHandle<T>
  patch: any //Automerge.Patch
  before: Automerge.Doc<T>
  after: Automerge.Doc<T>
}

export interface DocHandleEvents<T> {
  change: (event: DocHandleChangeEvent<T>) => void
  patch: (event: DocHandlePatchEvent<T>) => void
}
