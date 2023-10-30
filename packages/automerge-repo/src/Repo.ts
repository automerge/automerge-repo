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
import { NetworkSubsystem } from "./network/NetworkSubsystem.js"
import { StorageSubsystem } from "./storage/StorageSubsystem.js"
import { CollectionSynchronizer } from "./synchronizer/CollectionSynchronizer.js"
import type { AnyDocumentId, DocumentId } from "./types.js"
import { pause } from "./helpers/pause.js"
import { RepoEvents, RepoConfig } from "./types.js"
import { AuthProvider } from "./auth/AuthProvider.js"

/** A Repo is a collection of documents with networking, syncing, and storage capabilities. */
/** The `Repo` is the main entry point of this library
 *
 * @remarks
 * To construct a `Repo` you will need an {@link StorageAdapter} and one or more
 * {@link NetworkAdapter}s. Once you have a `Repo` you can use it to obtain {@link DocHandle}s.
 */
export class Repo extends EventEmitter<RepoEvents> {
  #log: debug.Debugger

  authProvider: AuthProvider

  /** @hidden */
  networkSubsystem: NetworkSubsystem

  /** @hidden */
  storageSubsystem?: StorageSubsystem

  /** @hidden */
  #synchronizer: CollectionSynchronizer

  /** The debounce rate is adjustable on the repo. */
  /** @hidden */
  saveDebounceRate = 100

  /** Cached handles */
  handles: Record<DocumentId, DocHandle<any>> = {}

  constructor(config: RepoConfig) {
    super()
    this.#log = debug(`automerge-repo:repo`)

    const {
      storage, //
      network: networkAdapters,
      peerId,
    } = config

    if ("authProvider" in config) {
      this.authProvider = config.authProvider!
    } else if ("sharePolicy" in config) {
      this.authProvider = new AuthProvider({
        okToAdvertise: config.sharePolicy!,
        okToSync: config.sharePolicy!,
      })
    } else {
      this.authProvider = new AuthProvider() // maximally permissive by default
    }

    // add automatic logging to all events
    this.emit = (event, ...args) => {
      this.#log(`${event} %o`, args)
      return super.emit(event, ...args)
    }

    // The synchronizer uses the network subsystem to keep documents in sync with peers.
    this.#synchronizer = new CollectionSynchronizer(this)

    // When the synchronizer emits messages, send them to peers
    this.#synchronizer.on("message", message => {
      this.#log(`sending ${message.type} message to ${message.targetId}`)
      this.networkSubsystem.send(message)
    })

    // The storage subsystem has access to some form of persistence, and deals with save and loading documents.
    this.storageSubsystem = storage ? new StorageSubsystem(storage) : undefined

    // The network subsystem deals with sending and receiving messages to and from peers.

    // The auth provider works by wrapping our network adapters.
    const wrappedAdapters =
      "authProvider" in config
        ? networkAdapters.map(adapter =>
            this.authProvider.wrapNetworkAdapter(adapter)
          )
        : networkAdapters

    const networkSubsystem = new NetworkSubsystem(wrappedAdapters, peerId)
    this.networkSubsystem = networkSubsystem

    // When we get a new peer, register it with the synchronizer
    this.networkSubsystem.on("peer", ({ peerId }) => {
      this.#log("peer connected", { peerId })
      this.#synchronizer.addPeer(peerId)
    })

    // When a peer disconnects, remove it from the synchronizer
    this.networkSubsystem.on("peer-disconnected", ({ peerId }) => {
      this.#synchronizer.removePeer(peerId)
    })

    // Pass incoming messages on to the synchronizer
    this.networkSubsystem.on("message", msg => {
      this.#synchronizer.receiveMessage(msg)
    })

    // Handle errors
    networkSubsystem.on("error", err => {
      this.#log("network error", { err })
    })
  }

  /** Returns an existing handle if we have it; creates one otherwise. */
  #getHandle<T>(params: { documentId: DocumentId; isNew: boolean }) {
    const { documentId, isNew } = params

    // If we have the handle cached, return it
    if (this.handles[documentId]) return this.handles[documentId]

    // If not, create a new handle, cache it, and return it
    const handle = new DocHandle<T>(documentId, { isNew })
    this.handles[documentId] = handle
    return handle
  }

  /**
   * When we create a new document or look up a document by ID, wire up storage and network
   * synchronization.
   */
  async #registerHandle<T>(params: { handle: DocHandle<T>; isNew: boolean }) {
    const { handle, isNew } = params
    const { documentId } = handle

    if (this.storageSubsystem) {
      // Listen for changes and save them to disk, but not more frequently than the debounce interval
      const save = ({ doc }: DocHandleEncodedChangePayload<any>) => {
        void this.storageSubsystem!.saveDoc(documentId, doc)
      }
      handle.on("heads-changed", throttle(save, this.saveDebounceRate))

      if (isNew) {
        // this is a new document, immediately save it
        await this.storageSubsystem.saveDoc(documentId, handle.docSync()!)
      } else {
        // otherwise try to load it from storage
        const loadedDoc = await this.storageSubsystem.loadDoc(documentId)
        if (loadedDoc) {
          handle.update(() => loadedDoc as Automerge.Doc<T>)
        }
      }
    }

    // If the handle is unavailable, let the application know
    handle.on("unavailable", () => {
      this.emit("unavailable-document", { documentId })
    })

    // Let the handle know when the network is ready
    if (this.networkSubsystem.isReady()) {
      handle.request()
    } else {
      handle.awaitNetwork()
      await this.networkSubsystem.whenReady()
      handle.networkReady()
    }

    // Register the document with the synchronizer. This advertises our interest in the document.
    this.#synchronizer.addDocument(documentId)

    // Notify the application that we have a document
    this.emit("document", { handle, isNew })
  }

  /**
   * Creates a new document, advertises it to the network, and returns a handle to it. The initial
   * value of the document is an empty object `{}`. Its documentId is a UUID is generated by the
   * system.
   */
  create<T>(): DocHandle<T> {
    const { documentId } = parseAutomergeUrl(generateAutomergeUrl())
    const handle = this.#getHandle<T>({ documentId, isNew: true })
    void this.#registerHandle({ handle, isNew: true })
    return handle
  }

  /** Create a new DocHandle by cloning the history of an existing DocHandle.
   *
   * @remarks This is a wrapper around the `clone` function in the Automerge library. The new
   * `DocHandle` will have a new URL but will share history with the original, which means that
   * changes made to the cloned handle can be sensibly merged back into the original.
   *
   * Any peers this `Repo` is connected to for whom `sharePolicy` returns `true` will be notified of
   * the newly created DocHandle.
   *
   * @throws if the cloned handle is not yet ready or if `clonedHandle.docSync()` returns
   * `undefined` (i.e. the handle is unavailable).
   */
  clone<T>(
    /** The handle to clone */
    sourceHandle: DocHandle<T>
  ) {
    if (!sourceHandle.isReady())
      throw new Error(
        "Cloned handle is not yet in ready state. (Try await handle.waitForReady() first.)"
      )

    const sourceDoc = sourceHandle.docSync()
    if (!sourceDoc) throw new Error("Cloned handle doesn't have a document.")

    // create a new handle and replace it's doc with the new cloned one
    const handle = this.create<T>()
    handle.update(() => Automerge.clone(sourceDoc))
    return handle
  }

  /**
   * Retrieves a document by id. It gets data from the local system, but registers interest in the
   * document with the network.
   */
  find<T>(
    /** The url or documentId of the handle to retrieve */
    id: AnyDocumentId
  ): DocHandle<T> {
    const documentId = interpretAsDocumentId(id)
    {
      // If we have the handle cached, return it
      const handle = this.handles[documentId]
      if (handle) {
        // if unavailable, emit an event after returning the handle
        if (handle.isUnavailable())
          void pause().then(() => handle.emit("unavailable"))
        return handle
      }
    }
    {
      // Otherwise create a new handle and register it
      const handle = this.#getHandle<T>({ documentId, isNew: false })
      void this.#registerHandle({ handle, isNew: false })
      return handle
    }
  }

  delete(
    /** The url or documentId of the handle to delete */
    id: AnyDocumentId
  ) {
    const documentId = interpretAsDocumentId(id)

    // let the handle know it's been deleted
    const handle = this.#getHandle({ documentId, isNew: false })
    handle.delete()

    // remove it from the cache
    delete this.handles[documentId]

    // remove it from storage
    void this.storageSubsystem?.removeDoc(documentId)

    // TODO Pass the delete on to the network
    // synchronizer.removeDocument(documentId)

    // notify the application
    this.emit("delete-document", { documentId })
  }
}
