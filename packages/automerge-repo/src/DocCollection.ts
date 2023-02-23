import EventEmitter from "eventemitter3"
import { v4 } from "uuid"
import { DocHandle, DocHandleOptions, DocumentId } from "./DocHandle.js"

export class DocCollection extends EventEmitter<DocCollectionEvents<unknown>> {
  handles: { [documentId: DocumentId]: DocHandle<unknown> } = {}

  constructor() {
    super()
  }

  cacheHandle(
    documentId: DocumentId,
    newDoc: boolean,
    options: DocHandleOptions = {}
  ): DocHandle<unknown> {
    if (this.handles[documentId]) {
      return this.handles[documentId]
    }
    const handle = new DocHandle<unknown>(documentId, newDoc, options)
    this.handles[documentId] = handle
    return handle
  }

  // TODO: this should really insist on initial value of T
  // (but: we need to make sure the storage system will collect it)
  // (next: we need to have some kind of reify function)
  // (then: cambria!)
  create<T>(options?: DocHandleOptions): DocHandle<T> {
    const documentId = v4() as DocumentId
    const handle = this.cacheHandle(documentId, true, options) as DocHandle<T>
    this.emit("document", { handle })
    return handle
  }

  /**
   * find() locates a document by id. It gets data from the local system, but also by sends a
   * 'document' event which a CollectionSynchronizer would use to advertise interest to other peers
   */
  find<T>(documentId: DocumentId, options?: DocHandleOptions): DocHandle<T> {
    // TODO: we want a way to make sure we don't yield
    //       intermediate document states during initial synchronization
    if (this.handles[documentId]) {
      return this.handles[documentId] as DocHandle<T>
    }
    const handle = this.cacheHandle(documentId, false, options)

    // we don't directly initialize a value here because
    // the StorageSubsystem and Synchronizers go and get the data
    // asynchronously and block on read instead of on create
    this.emit("document", { handle })

    return handle as DocHandle<T>
  }
}

export interface DocCollectionDocumentEventArg<T> {
  handle: DocHandle<T>
}
export interface DocCollectionEvents<T> {
  document: (arg: DocCollectionDocumentEventArg<T>) => void
}
