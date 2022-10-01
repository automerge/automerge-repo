import EventEmitter from "eventemitter3"
import { v4 } from "uuid"
import * as Automerge from "automerge"
import { DocHandle, DocumentId } from "./DocHandle.js"

export class DocCollection extends EventEmitter<DocCollectionEvents<unknown>> {
  handles: { [documentId: DocumentId]: DocHandle<unknown> } = {}

  constructor() {
    super()
  }

  cacheHandle(documentId: DocumentId): DocHandle<unknown> {
    if (this.handles[documentId]) {
      return this.handles[documentId]
    }
    const handle = new DocHandle<unknown>(documentId)
    this.handles[documentId] = handle
    return handle
  }

  create<T>(): DocHandle<T> {
    const documentId = v4() as DocumentId
    const handle = this.cacheHandle(documentId) as DocHandle<T>
    handle.replace(Automerge.init())
    this.emit("document", { handle, justCreated: true })
    return handle
  }

  /**
   * find() locates a document by id. It gets data from the local system, but also by sends a
   * 'document' event which a CollectionSynchronizer would use to advertise interest to other peers
   */
  find<T>(documentId: DocumentId): DocHandle<T> {
    // TODO: we want a way to make sure we don't yield
    //       intermediate document states during initial synchronization
    if (this.handles[documentId]) {
      return this.handles[documentId] as DocHandle<T>
    }
    const handle = this.cacheHandle(documentId)

    // we don't directly initialize a value here because
    // the StorageSubsystem and Synchronizers go and get the data
    // they'll fill it in via a first replace() call and until then anyone
    // accessing the value of this will block
    this.emit("document", { handle, justCreated: false })

    return handle as DocHandle<T>
  }
}

export interface DocCollectionDocumentEventArg<T> {
  handle: DocHandle<T>
  justCreated: boolean // hint for the storage system. TODO: smooth this away.
}
export interface DocCollectionEvents<T> {
  document: (arg: DocCollectionDocumentEventArg<T>) => void
}
