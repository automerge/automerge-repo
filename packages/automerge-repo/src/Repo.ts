import { next as Automerge } from "@automerge/automerge"
import debug from "debug"
import { EventEmitter } from "eventemitter3"
import {
  generateAutomergeUrl,
  interpretAsDocumentId,
  parseAutomergeUrl,
} from "./AutomergeUrl.js"
import { DocHandle, DocHandleEncodedChangePayload } from "./DocHandle.js"
import { throttle } from "./helpers/throttle.js"
import { NetworkAdapter } from "./network/NetworkAdapter.js"
import { NetworkSubsystem } from "./network/NetworkSubsystem.js"
import { StorageAdapter } from "./storage/StorageAdapter.js"
import { StorageSubsystem } from "./storage/StorageSubsystem.js"
import { CollectionSynchronizer } from "./synchronizer/CollectionSynchronizer.js"
import type { AnyDocumentId, DocumentId, PeerId } from "./types.js"

/** A Repo is a collection of documents with networking, syncing, and storage capabilities. */
/** The `Repo` is the main entry point of this library
 *
 * @remarks
 * To construct a `Repo` you will need an {@link StorageAdapter} and one or more
 * {@link NetworkAdapter}s. Once you have a `Repo` you can use it to obtain {@link DocHandle}s.
 */
export class Repo extends EventEmitter<RepoEvents> {
  #log: debug.Debugger

  /** @hidden */
  networkSubsystem: NetworkSubsystem

  /** @hidden */
  storageSubsystem?: StorageSubsystem

  /** @hidden */
  synchronizer = new CollectionSynchronizer(this)

  /** The debounce rate is adjustable on the repo. */
  /** @hidden */
  saveDebounceRate = 100

  #handleCache: Record<DocumentId, DocHandle<any>> = {}

  /** By default, we share generously with all peers. */
  /** @hidden */
  sharePolicy: SharePolicy = async () => true

  constructor({ storage, network, peerId, sharePolicy }: RepoConfig) {
    super()
    this.#log = debug(`automerge-repo:repo`)

    // add automatic logging to all events
    this.emit = (event, ...args) => {
      this.#log(`${event} %o`, args)
      return super.emit(event, ...args)
    }

    this.sharePolicy = sharePolicy ?? this.sharePolicy

    this.on("delete-document", ({ documentId }) => {
      // TODO Pass the delete on to the network
      // synchronizer.removeDocument(documentId)

      this.storageSubsystem?.removeDoc(documentId).catch(err => {
        this.#log("error deleting document", { documentId, err })
      })
    })

    // SYNCHRONIZER
    // The synchronizer uses the network subsystem to keep documents in sync with peers.

    // When the synchronizer emits messages, send them to peers
    this.synchronizer.on("message", message => {
      this.#log(`sending ${message.type} message to ${message.targetId}`)
      this.networkSubsystem.send(message)
    })

    // STORAGE
    // The storage subsystem has access to some form of persistence, and deals with save and loading documents.
    this.storageSubsystem = storage ? new StorageSubsystem(storage) : undefined

    // NETWORK
    // The network subsystem deals with sending and receiving messages to and from peers.
    this.networkSubsystem = new NetworkSubsystem(network, peerId)

      // When we get a new peer, register it with the synchronizer
      .on("peer", async ({ peerId }) => {
        this.#log("peer connected", { peerId })
        this.synchronizer.addPeer(peerId)
      })

      // When a peer disconnects, remove it from the synchronizer
      .on("peer-disconnected", ({ peerId }) => {
        this.synchronizer.removePeer(peerId)
      })

      // Handle incoming messages
      .on("message", async msg => {
        await this.synchronizer.receiveMessage(msg)
      })
  }

  /** Returns an existing handle if we have it; creates one otherwise. */
  #getHandle<T>(
    /** The documentId of the handle to look up or create */
    documentId: DocumentId,

    /** If we know we're creating a new document, specify this so we can have access to it immediately */
    isNew: boolean
  ) {
    // If we have the handle cached, return it
    if (this.#handleCache[documentId]) return this.#handleCache[documentId]

    // If not, create a new handle, cache it, and return it
    if (!documentId) throw new Error(`Invalid documentId ${documentId}`)
    const handle = new DocHandle<T>(documentId, { isNew })
    this.#handleCache[documentId] = handle
    return handle
  }

  /**
   * When we create a new document or look up a document by ID, wire up storage and network
   * synchronization.
   */
  async #registerHandle<T>(handle: DocHandle<T>, isNew: boolean) {
    const { documentId } = handle

    // If we have a storage subsystem, save the document when it changes
    const storageSubsystem = this.storageSubsystem
    if (storageSubsystem) {
      // Save when the document changes, but no more often than saveDebounceRate.
      const saveFn = ({ handle, doc }: DocHandleEncodedChangePayload<any>) => {
        void storageSubsystem.saveDoc(documentId, doc)
      }
      const debouncedSaveFn = handle.on(
        "heads-changed",
        throttle(saveFn, this.saveDebounceRate)
      )

      if (isNew) {
        // this is a new document, immediately save it
        await storageSubsystem.saveDoc(documentId, handle.docSync()!)
      } else {
        // Try to load from disk
        const loadedDoc = await storageSubsystem.loadDoc(documentId)
        if (loadedDoc) {
          handle.update(() => loadedDoc as Automerge.Doc<T>)
        }
      }
    }

    // Forward "unavailable" events from this handle
    handle.on("unavailable", () => {
      this.emit("unavailable-document", { documentId })
    })

    // Let the handle know when the network is ready
    if (this.networkSubsystem.isReady()) {
      handle.request()
    } else {
      handle.awaitNetwork()
      this.networkSubsystem
        .whenReady()
        .then(() => {
          handle.networkReady()
        })
        .catch(err => {
          this.#log("error waiting for network", { err })
        })
    }

    // Register the document with the synchronizer. This advertises our interest in the document.
    this.synchronizer.addDocument(documentId)

    // Notify listeners that we have a document
    this.emit("document", { handle, isNew })
  }

  /** Returns all the handles we have cached. */
  get handles() {
    return this.#handleCache
  }

  /**
   * Creates a new document and returns a handle to it. The initial value of the document is
   * an empty object `{}`. Its documentId is generated by the system.
   */
  create<T>(): DocHandle<T> {
    // TODO:
    // either
    // - pass an initial value and do something like this to ensure that you get a valid initial value

    // const myInitialValue = {
    //   tasks: [],
    //   filter: "all",
    //
    // const guaranteeInitialValue = (doc: any) => {
    // if (!doc.tasks) doc.tasks = []
    // if (!doc.filter) doc.filter = "all"

    //   return { ...myInitialValue, ...doc }
    // }

    // or
    // - pass a "reify" function that takes a `<any>` and returns `<T>`

    // Generate a new UUID and store it in the buffer
    const { documentId } = parseAutomergeUrl(generateAutomergeUrl())
    const handle = this.#getHandle<T>(documentId, true) as DocHandle<T>
    this.#registerHandle(handle, true)
    return handle
  }

  /** Create a new DocHandle by cloning the history of an existing DocHandle.
   *
   * @param clonedHandle - The handle to clone
   *
   * @remarks This is a wrapper around the `clone` function in the Automerge library.
   * The new `DocHandle` will have a new URL but will share history with the original,
   * which means that changes made to the cloned handle can be sensibly merged back
   * into the original.
   *
   * Any peers this `Repo` is connected to for whom `sharePolicy` returns `true` will
   * be notified of the newly created DocHandle.
   *
   * @throws if the cloned handle is not yet ready or if
   * `clonedHandle.docSync()` returns `undefined` (i.e. the handle is unavailable).
   */
  clone<T>(clonedHandle: DocHandle<T>) {
    if (!clonedHandle.isReady()) {
      throw new Error(
        `Cloned handle is not yet in ready state.
        (Try await handle.waitForReady() first.)`
      )
    }

    const sourceDoc = clonedHandle.docSync()
    if (!sourceDoc) {
      throw new Error("Cloned handle doesn't have a document.")
    }

    const handle = this.create<T>()

    handle.update(() => {
      // we replace the document with the new cloned one
      return Automerge.clone(sourceDoc)
    })

    return handle
  }

  /**
   * Retrieves a document by id. It gets data from the local system, but also emits a `document`
   * event to advertise interest in the document.
   */
  find<T>(
    /** The url or documentId of the handle to retrieve */
    id: AnyDocumentId
  ): DocHandle<T> {
    const documentId = interpretAsDocumentId(id)

    // If we have the handle cached, return it
    if (this.#handleCache[documentId]) {
      if (this.#handleCache[documentId].isUnavailable()) {
        // this ensures that the event fires after the handle has been returned
        setTimeout(() => {
          this.#handleCache[documentId].emit("unavailable", {
            handle: this.#handleCache[documentId],
          })
        })
      }
      return this.#handleCache[documentId]
    }

    const handle = this.#getHandle<T>(documentId, false) as DocHandle<T>
    this.#registerHandle(handle, false)
    return handle
  }

  delete(
    /** The url or documentId of the handle to delete */
    id: AnyDocumentId
  ) {
    const documentId = interpretAsDocumentId(id)

    const handle = this.#getHandle(documentId, false)
    handle.delete()

    delete this.#handleCache[documentId]
    this.emit("delete-document", { documentId })
  }
}

export interface RepoConfig {
  /** Our unique identifier */
  peerId?: PeerId

  /** A storage adapter can be provided, or not */
  storage?: StorageAdapter

  /** One or more network adapters must be provided */
  network: NetworkAdapter[]

  /**
   * Normal peers typically share generously with everyone (meaning we sync all our documents with
   * all peers). A server only syncs documents that a peer explicitly requests by ID.
   */
  sharePolicy?: SharePolicy
}

/** A function that determines whether we should share a document with a peer
 *
 * @remarks
 * This function is called by the {@link Repo} every time a new document is created
 * or discovered (such as when another peer starts syncing with us). If this
 * function returns `true` then the {@link Repo} will begin sharing the new
 * document with the peer given by `peerId`.
 * */
export type SharePolicy = (
  peerId: PeerId,
  documentId?: DocumentId
) => Promise<boolean>

// events & payloads
export interface RepoEvents {
  /** A new document was created or discovered */
  document: (arg: DocumentPayload) => void
  /** A document was deleted */
  "delete-document": (arg: DeleteDocumentPayload) => void
  /** A document was marked as unavailable (we don't have it and none of our peers have it) */
  "unavailable-document": (arg: DeleteDocumentPayload) => void
}

export interface DocumentPayload {
  handle: DocHandle<any>
  isNew: boolean
}

export interface DeleteDocumentPayload {
  documentId: DocumentId
}
