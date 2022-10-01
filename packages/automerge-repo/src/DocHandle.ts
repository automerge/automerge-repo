import EventEmitter from "eventemitter3"
import * as Automerge from "automerge"

export type DocumentId = string & { __documentId: true }

/**
 * DocHandle is a wrapper around a single Automerge document that allows us to listen for changes.
 */
export class DocHandle<T> extends EventEmitter<DocHandleEvents<T>> {
  doc?: Automerge.Doc<T>
  documentId: DocumentId

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
  }

  async updateDoc(callback: (doc: Automerge.Doc<T>) => Automerge.Doc<T>) {
    if (!this.doc) {
      await new Promise((resolve) => {
        this.once("change", resolve)
      })
    }
    if (this.doc) this.replace(callback(this.doc))
    else throw new Error("Unexpected null document")
  }

  // TODO: should i move this?
  change(callback: (doc: T) => void) {
    if (!this.doc) {
      throw new Error("Can't call change before establishing a document.")
    }
    const doc = Automerge.change<T>(this.doc, callback)
    this.replace(doc)
  }

  // TODO: there's a race condition where you could call change() before init()
  //       we aren't hitting it anywhere i can think of but change/updateDoc need some thought
  replace(doc: Automerge.Doc<T>) {
    const oldDoc = this.doc
    this.doc = doc
    const { documentId } = this

    this.emit("change", {
      handle: this,
      documentId,
      doc,
      changes: Automerge.getChanges(oldDoc || Automerge.init(), doc),
    })
  }

  async value() {
    if (!this.doc) {
      // TODO: this bit of jank blocks anyone else getting the value before the first time data gets
      // set into here
      await new Promise((resolve) => {
        this.once("change", resolve)
      })
    }
    if (this.doc) return this.doc
    else throw new Error("Unexpected null document")
  }
}

export interface DocHandleEventArg<T> {
  handle: DocHandle<T>
  documentId: DocumentId
  doc: Automerge.Doc<T>
  changes: Uint8Array[]
}

export interface DocHandleEvents<T> {
  change: (event: DocHandleEventArg<T>) => void
}
