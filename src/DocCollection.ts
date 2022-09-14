import EventEmitter from "eventemitter3"
import { v4 } from "uuid"
import * as Automerge from "automerge-js"
import DocHandle from "./DocHandle.js"
import StorageSubsystem from "./storage/StorageSubsystem.js"

export interface DocCollectionDocumentEventArg<T> {
  handle: DocHandle<T>
}
export interface DocCollectionEvents<T> {
  document: (arg: DocCollectionDocumentEventArg<T>) => void
}

export default class DocCollection extends EventEmitter<
  DocCollectionEvents<unknown>
> {
  handles: { [documentId: string]: DocHandle<unknown> } = {}
  storageSubsystem: StorageSubsystem

  constructor(storageSubsystem: StorageSubsystem) {
    super()
    this.storageSubsystem = storageSubsystem
  }

  cacheHandle(documentId: string): DocHandle<unknown> {
    if (this.handles[documentId]) {
      return this.handles[documentId]
    }
    const handle = new DocHandle<unknown>(documentId)
    this.handles[documentId] = handle
    return handle
  }

  /* this is janky, because it returns an empty (but editable) document
   * before anything loads off the network.
   * fixing this probably demands some work in automerge core.
   */
  async load<T>(documentId: string): Promise<DocHandle<T>> {
    const handle = this.cacheHandle(documentId)
    handle.replace(
      (await this.storageSubsystem.load(documentId)) || Automerge.init()
    )
    this.emit("document", { handle })
    return handle as DocHandle<T>
  }

  create<T>(): DocHandle<T> {
    const documentId = v4()
    const handle = this.cacheHandle(documentId) as DocHandle<T>
    handle.replace(Automerge.init())
    this.emit("document", { handle })
    return handle
  }

  /**
   * find() locates a document by id
   * getting data from the local system but also by sending out a 'document'
   * event which a CollectionSynchronizer would use to advertise interest to other peers
   */
  async find<T>(documentId: string): Promise<DocHandle<T>> {
    // TODO: we want a way to make sure we don't yield
    //       intermediate document states during initial synchronization
    return (this.handles[documentId] || this.load(documentId)) as DocHandle<T>
  }
}
