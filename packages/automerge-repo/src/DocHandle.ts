import EventEmitter from "eventemitter3"
import * as Automerge from "@automerge/automerge"

export type DocumentId = string & { __documentId: true }

/**
 * DocHandle is a wrapper around a single Automerge document that allows us to listen for changes.
 */
export class DocHandle<T> extends EventEmitter<DocHandleEvents<T>> {
  doc: Automerge.Doc<T>
  documentId: DocumentId
  anyDataReceived = false // TODO: wait until we have the whole doc

  // TODO: DocHandle is kind of terrible because we have to be careful to preserve a 1:1
  // relationship between handles and documentIds or else we have split-brain on listeners.
  // It would be easier just to have one repo object to pass around but that means giving
  // total repo access to everything which seems gratuitous to me.

  constructor(documentId: DocumentId) {
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
  }

  change(callback: (doc: T) => void) {
    const newDoc = Automerge.change<T>(this.doc, callback)
    this.__notifyChangeListeners(newDoc)
  }

  receiveSyncMessage(syncState: Automerge.SyncState, message: Uint8Array) {
    const [newDoc, newSyncState] = Automerge.receiveSyncMessage(
      this.doc,
      syncState,
      message
    )
    this.__notifyChangeListeners(newDoc)
    return newSyncState
  }

  __notifyChangeListeners(newDoc: Automerge.Doc<T>) {
    const oldDoc = this.doc
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
    console.log(this.documentId, "pitched", patch, JSON.stringify(this.doc))
    this.doc = after
    this.emit("patch", { handle: this, patch, before, after })
  }

  async value() {
    return this.doc
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
