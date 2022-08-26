/* So this class is kind of terrible because we have to be careful to preserve a 1:1
 * relationship between handles and documentIds or else we have split-brain on listeners.
 * It would be easier just to have one repo object to pass around but that means giving
 * total repo access to everything which seems gratuitous to me.
 */
import EventEmitter from "eventemitter3"
import * as Automerge from "automerge-js"

export interface DocHandleEventArg<T> {
  handle: DocHandle<T>
  documentId: string
  doc: Automerge.Doc<T>
  changes: Uint8Array[]
}
export interface DocHandleEvents<T> {
  change: (event: DocHandleEventArg<T>) => void
}

export default class DocHandle<T> extends EventEmitter<DocHandleEvents<T>> {
  doc?: Automerge.Doc<T>

  documentId

  constructor(documentId: string) {
    super()
    if (!documentId) {
      throw new Error("Need a document ID for this RepoDoc.")
    }
    this.documentId = documentId
  }

  async updateDoc(callback: (doc: T) => T) {
    if (!this.doc) {
      await new Promise((resolve) => {
        this.once("change", resolve)
      })
    }
    this.replace(callback(this.doc))
  }

  // should i move this?
  change(callback: (doc: T) => void) {
    if (!this.doc) {
      throw new Error("Can't call change before establishing a document.")
    }
    const doc = Automerge.change<T>(this.doc, callback)
    this.replace(doc)
  }

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

  /* hmmmmmmmmmmm */
  async value() {
    if (!this.doc) {
      /* this bit of jank blocks anyone else getting the value
         before the first time data gets set into here */
      await new Promise((resolve) => {
        this.once("change", resolve)
      })
    }
    return this.doc
  }
}
