import { next as Automerge } from "@automerge/automerge/slim"
import debug from "debug"
import { EventEmitter } from "eventemitter3"
import {
  generateAutomergeUrl,
  interpretAsDocumentId,
  parseAutomergeUrl,
} from "./AutomergeUrl.js"
import {
  DELETED,
  DocHandle,
  DocHandleEncodedChangePayload,
  READY,
  UNAVAILABLE,
  UNLOADED,
} from "./DocHandle.js"
import { headsAreSame } from "./helpers/headsAreSame.js"
import { throttle } from "./helpers/throttle.js"
import {
  NetworkAdapterInterface,
  type PeerMetadata,
} from "./network/NetworkAdapterInterface.js"
import { NetworkSubsystem } from "./network/NetworkSubsystem.js"
import { MessageContents, RepoMessage } from "./network/messages.js"
import { StorageAdapterInterface } from "./storage/StorageAdapterInterface.js"
import { StorageSubsystem } from "./storage/StorageSubsystem.js"
import { StorageId } from "./storage/types.js"
import { CollectionSynchronizer } from "./synchronizer/CollectionSynchronizer.js"
import {
  DocSyncMetrics,
  SyncStatePayload,
} from "./synchronizer/Synchronizer.js"
import type {
  AnyDocumentId,
  AutomergeUrl,
  DocumentId,
  PeerId,
} from "./types.js"
import { Progress } from "./ferigan.js"
import { CollectionHandle } from "./CollectionHandle.js"
import { next as A } from "@automerge/automerge/slim"
import { InMemoryStorageAdapter } from "./storage/StorageAdapter.js"

function randomPeerId() {
  return ("peer-" + Math.random().toString(36).slice(4)) as PeerId
}

/** A Repo is a collection of documents with networking, syncing, and storage capabilities. */
/** The `Repo` is the main entry point of this library
 *
 * @remarks
 * To construct a `Repo` you will need an {@link StorageAdapter} and one or
 * more {@link NetworkAdapter}s. Once you have a `Repo` you can use it to
 * obtain {@link DocHandle}s.
 */
export class Repo extends EventEmitter<RepoEvents> {
  #log: debug.Debugger

  /** @hidden */
  networkSubsystem: NetworkSubsystem
  storageSubsystem: StorageSubsystem

  #handleCache: Record<DocumentId, DocHandle<any>> = {}

  /** @hidden */
  synchronizer: CollectionSynchronizer

  /** By default, we share generously with all peers. */
  /** @hidden */
  sharePolicy: SharePolicy = async () => true

  /** maps peer id to to persistence information (storageId, isEphemeral), access by collection synchronizer  */
  /** @hidden */
  peerMetadataByPeerId: Record<PeerId, PeerMetadata> = {}

  #beelay: A.beelay.Beelay

  constructor({
    storage,
    network = [],
    peerId = randomPeerId(),
    sharePolicy,
    isEphemeral = storage === undefined,
    enableRemoteHeadsGossiping = false,
    denylist = [],
  }: RepoConfig = {}) {
    super()
    if (storage == null) {
      // beelayStorage = new InMemoryStorageAdapter()
      storage = new InMemoryStorageAdapter()
    }
    this.#beelay = new A.beelay.Beelay({
      storage,
      peerId,
      requestPolicy: async ({ docId }) => {
        const peers = Array.from(this.networkSubsystem.peers)
        const generousPeers: PeerId[] = []
        for (const peerId of peers) {
          const okToShare = await this.sharePolicy(peerId)
          if (okToShare) generousPeers.push(peerId)
        }
        return generousPeers
      },
    })
    this.storageSubsystem = new StorageSubsystem(this.#beelay, storage)
    this.#log = debug(`automerge-repo:repo`)
    this.sharePolicy = sharePolicy ?? this.sharePolicy

    this.#beelay.on("message", ({ message }) => {
      this.#log(`sending ${message} message to ${message.recipient}`)
      networkSubsystem.send({
        targetId: message.recipient as PeerId,
        type: "beelay",
        ...message,
      } as MessageContents)
    })

    this.#beelay.on("docEvent", event => {
      this.#log(`received ${event.data.type} event for ${event.docId}`)
      const handle = this.#handleCache[event.docId as DocumentId]
      if (handle != null) {
        handle.update(d => Automerge.loadIncremental(d, event.data.contents))
      }
    })

    this.#beelay.on("bundleRequired", ({ start, end, checkpoints, docId }) => {
      ;(async () => {
        const doc = await this.storageSubsystem.loadDoc(docId as DocumentId)
        if (doc == null) {
          console.warn("document not found when creating bundle")
          return
        }
        const bundle = A.saveBundle(doc, start, end)
        this.#beelay.addBundle({
          docId,
          checkpoints,
          start,
          end,
          data: bundle,
        })
      })()
    })

    // SYNCHRONIZER
    this.synchronizer = new CollectionSynchronizer(this.#beelay, this, [])

    this.synchronizer.on("message", message => {
      this.#log(`sending ${message.type} message to ${message.targetId}`)
      networkSubsystem.send(message)
    })

    // NETWORK
    // The network subsystem deals with sending and receiving messages to and from peers.

    const myPeerMetadata: Promise<PeerMetadata> = (async () => ({
      // storageId: await this.storageSubsystem.id(),
      isEphemeral,
    }))()

    const networkSubsystem = new NetworkSubsystem(
      network,
      peerId,
      myPeerMetadata
    )
    this.networkSubsystem = networkSubsystem

    // When we get a new peer, register it with the synchronizer
    networkSubsystem.on("peer", async ({ peerId, peerMetadata }) => {
      this.#log("peer connected", { peerId })
      if (peerMetadata) {
        this.peerMetadataByPeerId[peerId] = { ...peerMetadata }
      }
      this.synchronizer.addPeer(peerId)
    })

    // Handle incoming messages
    networkSubsystem.on("message", async msg => {
      //@ts-ignore
      // const inspected = A.beelay.inspectMessage(msg.message)
      // this.#log(`received msg: ${JSON.stringify(inspected)}`)
      //@ts-ignore
      if (msg.type === "beelay") {
        if (!(msg.message instanceof Uint8Array)) {
          // The Uint8Array instance in the vitest VM is _different_ from the
          // Uint8Array instance which is available in this file for some reason.
          // So, even though `msg.message` _is_ a `Uint8Array`, we have to do this
          // absurd thing to get the tests to pass
          msg.message = Uint8Array.from(msg.message)
        }
        this.#beelay.receiveMessage({
          message: {
            sender: msg.senderId,
            recipient: msg.targetId,
            message: msg.message,
          },
        })
      } else {
        this.#receiveMessage(msg)
      }
    })
  }

  // The `document` event is fired by the DocCollection any time we create a new document or look
  // up a document by ID. We listen for it in order to wire up storage and network synchronization.
  #registerHandleWithSubsystems(handle: DocHandle<any>) {
    handle.on("heads-changed", () => {
      const doc = handle.docSync()
      if (doc != null) {
        this.storageSubsystem.saveDoc(handle.documentId, doc)
      }
    })
    handle.on("unavailable", () => {
      this.#log("document unavailable", { documentId: handle.documentId })
      this.emit("unavailable-document", {
        documentId: handle.documentId,
      })
    })

    this.synchronizer.addDocument(handle.documentId)

    // Preserve the old event in case anyone was using it.
    this.emit("document", { handle })
  }

  #receiveMessage(message: RepoMessage) {
    switch (message.type) {
      case "remote-subscription-change":
      case "remote-heads-changed":
        break
      case "sync":
      case "request":
      case "ephemeral":
      case "doc-unavailable":
        this.synchronizer.receiveMessage(message).catch(err => {
          console.error("error receiving message", { err })
        })
        break
    }
  }

  /** Returns an existing handle if we have it; creates one otherwise. */
  #getHandle<T>({
    documentId,
  }: {
    /** The documentId of the handle to look up or create */
    documentId: DocumentId /** If we know we're creating a new document, specify this so we can have access to it immediately */
  }) {
    // If we have the handle cached, return it
    if (this.#handleCache[documentId]) return this.#handleCache[documentId]

    // If not, create a new handle, cache it, and return it
    if (!documentId) throw new Error(`Invalid documentId ${documentId}`)
    const handle = new DocHandle<T>(documentId)
    this.#handleCache[documentId] = handle
    return handle
  }

  /** Returns all the handles we have cached. */
  get handles() {
    return this.#handleCache
  }

  /** Returns a list of all connected peer ids */
  get peers(): PeerId[] {
    return this.networkSubsystem.peers
  }

  getStorageIdOfPeer(peerId: PeerId): StorageId | undefined {
    return this.peerMetadataByPeerId[peerId]?.storageId
  }

  /**
   * Creates a new document and returns a handle to it. The initial value of the document is an
   * empty object `{}` unless an initial value is provided. Its documentId is generated by the
   * system. we emit a `document` event to advertise interest in the document.
   */
  create<T>(initialValue?: T): DocHandle<T> {
    // Generate a new UUID and store it in the buffer
    const { documentId } = parseAutomergeUrl(generateAutomergeUrl())
    const handle = this.#getHandle<T>({
      documentId,
    }) as DocHandle<T>

    let initialLinks: A.Link[] = []

    handle.update(() => {
      let nextDoc: Automerge.Doc<T>
      if (initialValue) {
        nextDoc = Automerge.from(initialValue)
      } else {
        nextDoc = Automerge.emptyChange(Automerge.init())
      }
      const patches = A.diff(nextDoc, [], A.getHeads(nextDoc))
      for (const patch of patches) {
        initialLinks = patches
          .map(patch => {
            if (patch.action === "put") {
              if (patch.value instanceof A.Link) {
                return patch.value
              }
            }
            return null
          })
          .filter(v => v != null)
      }
      return nextDoc
    })

    for (const link of initialLinks) {
      const { documentId: target } = parseAutomergeUrl(
        link.target as AutomergeUrl
      )
      this.#beelay.addLink({ from: documentId, to: target })
    }

    this.storageSubsystem.saveDoc(handle.documentId, handle.docSync()!)

    this.#registerHandleWithSubsystems(handle)

    handle.doneLoading()
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
        (Try await handle.whenReady() first.)`
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
    this.#log("find", { id })
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

    // If we don't already have the handle, make an empty one and try loading it
    const handle = this.#getHandle<T>({
      documentId,
    }) as DocHandle<T>

    // Loading & network is going to be asynchronous no matter what,
    // but we want to return the handle immediately.
    const attemptLoad = this.storageSubsystem.loadDoc(handle.documentId)

    attemptLoad
      .then(async loadedDoc => {
        if (loadedDoc) {
          // uhhhh, sorry if you're reading this because we were lying to the type system
          handle.update(() => loadedDoc as Automerge.Doc<T>)
          handle.doneLoading()
        } else {
          // we want to wait for the network subsystem to be ready before
          // we request the document. this prevents entering unavailable during initialization.
          await this.networkSubsystem.whenReady()
          console.log("we didn't find it so we're requesting")
          handle.request()
        }
        this.#registerHandleWithSubsystems(handle)
      })
      .catch(err => {
        this.#log("error waiting for network", { err })
      })
    return handle
  }

  delete(
    /** The url or documentId of the handle to delete */
    id: AnyDocumentId
  ) {
    const documentId = interpretAsDocumentId(id)

    const handle = this.#getHandle({ documentId })
    handle.delete()

    delete this.#handleCache[documentId]
    this.emit("delete-document", { documentId })
  }

  /**
   * Exports a document to a binary format.
   * @param id - The url or documentId of the handle to export
   *
   * @returns Promise<Uint8Array | undefined> - A Promise containing the binary document,
   * or undefined if the document is unavailable.
   */
  async export(id: AnyDocumentId): Promise<Uint8Array | undefined> {
    const documentId = interpretAsDocumentId(id)

    const handle = this.#getHandle({ documentId })
    const doc = await handle.doc()
    if (!doc) return undefined
    return Automerge.save(doc)
  }

  /**
   * Imports document binary into the repo.
   * @param binary - The binary to import
   */
  import<T>(binary: Uint8Array) {
    const doc = Automerge.load<T>(binary)

    const handle = this.create<T>()

    handle.update(() => {
      return Automerge.clone(doc)
    })

    return handle
  }

  subscribeToRemotes = (remotes: StorageId[]) => {}

  storageId = async (): Promise<StorageId | undefined> => {
    if (!this.storageSubsystem) {
      return undefined
    } else {
      return this.storageSubsystem.id()
    }
  }

  /**
   * Writes Documents to a disk.
   * @hidden this API is experimental and may change.
   * @param documents - if provided, only writes the specified documents.
   * @returns Promise<void>
   */
  async flush(documents?: DocumentId[]): Promise<void> {
    if (!this.storageSubsystem) {
      return
    }
    const handles = documents
      ? documents.map(id => this.#handleCache[id])
      : Object.values(this.#handleCache)
    await Promise.all(
      handles.map(async handle => {
        const doc = handle.docSync()
        if (!doc) {
          return
        }
        return this.storageSubsystem!.saveDoc(handle.documentId, doc)
      })
    )
  }

  /**
   * Removes a DocHandle from the handleCache.
   * @hidden this API is experimental and may change.
   * @param documentId - documentId of the DocHandle to remove from handleCache, if present in cache.
   * @returns Promise<void>
   */
  async removeFromCache(documentId: DocumentId) {
    if (!this.#handleCache[documentId]) {
      this.#log(
        `WARN: removeFromCache called but handle not found in handleCache for documentId: ${documentId}`
      )
      return
    }
    const handle = this.#getHandle({ documentId })
    const doc = await handle.doc([READY, UNLOADED, DELETED, UNAVAILABLE])
    if (doc) {
      if (handle.isReady()) {
        handle.unload()
      } else {
        this.#log(
          `WARN: removeFromCache called but handle for documentId: ${documentId} in unexpected state: ${handle.state}`
        )
      }
      delete this.#handleCache[documentId]
      // TODO: remove document from synchronizer when removeDocument is implemented
      // this.synchronizer.removeDocument(documentId)
    } else {
      this.#log(
        `WARN: removeFromCache called but doc undefined for documentId: ${documentId}`
      )
    }
  }

  shutdown(): Promise<void> {
    this.networkSubsystem.adapters.forEach(adapter => {
      adapter.disconnect()
    })
    return this.flush()
  }

  metrics(): { documents: { [key: string]: any } } {
    //return { documents: this.synchronizer.metrics() }
    return { documents: {} }
  }
}

export interface RepoConfig {
  /** Our unique identifier */
  peerId?: PeerId

  /** Indicates whether other peers should persist the sync state of this peer.
   * Sync state is only persisted for non-ephemeral peers */
  isEphemeral?: boolean

  /** A storage adapter can be provided, or not */
  storage?: StorageAdapterInterface

  /** A list of network adapters (more can be added at runtime). */
  network?: NetworkAdapterInterface[]

  /**
   * Normal peers typically share generously with everyone (meaning we sync all our documents with
   * all peers). A server only syncs documents that a peer explicitly requests by ID.
   */
  sharePolicy?: SharePolicy

  /**
   * Whether to enable the experimental remote heads gossiping feature
   */
  enableRemoteHeadsGossiping?: boolean

  /**
   * A list of automerge URLs which should never be loaded regardless of what
   * messages are received or what the share policy is. This is useful to avoid
   * loading documents that are known to be too resource intensive.
   */
  denylist?: AutomergeUrl[]
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
  "doc-metrics": (arg: DocMetrics) => void
}

export interface DocumentPayload {
  handle: DocHandle<any>
}

export interface DeleteDocumentPayload {
  documentId: DocumentId
}

export type DocMetrics =
  | DocSyncMetrics
  | {
      type: "doc-loaded"
      documentId: DocumentId
      durationMillis: number
      numOps: number
      numChanges: number
    }
  | {
      type: "doc-denied"
      documentId: DocumentId
    }
