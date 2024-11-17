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
import { RemoteHeadsSubscriptions } from "./RemoteHeadsSubscriptions.js"
import { headsAreSame } from "./helpers/headsAreSame.js"
import { throttle } from "./helpers/throttle.js"
import {
  NetworkAdapterInterface,
  type PeerMetadata,
} from "./network/NetworkAdapterInterface.js"
import { NetworkSubsystem } from "./network/NetworkSubsystem.js"
import { RepoMessage } from "./network/messages.js"
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
  /** @hidden */
  storageSubsystem?: StorageSubsystem

  /** The debounce rate is adjustable on the repo. */
  /** @hidden */
  saveDebounceRate = 100

  #handleCache: Record<DocumentId, DocHandle<any>> = {}

  /** @hidden */
  synchronizer: CollectionSynchronizer

  /** By default, we share generously with all peers. */
  /** @hidden */
  sharePolicy: SharePolicy = async () => true

  /** By default, we sync with all peers. */
  /** @hidden */
  syncPolicy: SyncPolicy = async () => true

  /** maps peer id to to persistence information (storageId, isEphemeral), access by collection synchronizer  */
  /** @hidden */
  peerMetadataByPeerId: Record<PeerId, PeerMetadata> = {}

  #remoteHeadsSubscriptions = new RemoteHeadsSubscriptions()
  #remoteHeadsGossipingEnabled = false

  constructor({
    storage,
    network = [],
    peerId = randomPeerId(),
    sharePolicy,
    syncPolicy,
    isEphemeral = storage === undefined,
    enableRemoteHeadsGossiping = false,
    denylist = [],
  }: RepoConfig = {}) {
    super()
    this.#remoteHeadsGossipingEnabled = enableRemoteHeadsGossiping
    this.#log = debug(`automerge-repo:repo`)
    this.sharePolicy = sharePolicy ?? this.sharePolicy
    this.syncPolicy = syncPolicy ?? this.syncPolicy

    this.on("delete-document", ({ documentId }) => {
      // TODO Pass the delete on to the network
      // synchronizer.removeDocument(documentId)

      if (storageSubsystem) {
        storageSubsystem.removeDoc(documentId).catch(err => {
          this.#log("error deleting document", { documentId, err })
        })
      }
    })

    // SYNCHRONIZER
    // The synchronizer uses the network subsystem to keep documents in sync with peers.
    this.synchronizer = new CollectionSynchronizer(this, denylist)

    // When the synchronizer emits messages, send them to peers
    this.synchronizer.on("message", message => {
      this.#log(`sending ${message.type} message to ${message.targetId}`)
      networkSubsystem.send(message)
    })

    // Forward metrics from doc synchronizers
    this.synchronizer.on("metrics", event => this.emit("doc-metrics", event))

    if (this.#remoteHeadsGossipingEnabled) {
      this.synchronizer.on("open-doc", ({ peerId, documentId }) => {
        this.#remoteHeadsSubscriptions.subscribePeerToDoc(peerId, documentId)
      })
    }

    // STORAGE
    // The storage subsystem has access to some form of persistence, and deals with save and loading documents.
    const storageSubsystem = storage ? new StorageSubsystem(storage) : undefined
    if (storageSubsystem) {
      storageSubsystem.on("document-loaded", event =>
        this.emit("doc-metrics", { type: "doc-loaded", ...event })
      )
    }

    this.storageSubsystem = storageSubsystem

    // NETWORK
    // The network subsystem deals with sending and receiving messages to and from peers.

    const myPeerMetadata: Promise<PeerMetadata> = (async () => ({
      storageId: await storageSubsystem?.id(),
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

      this.sharePolicy(peerId)
        .then(shouldShare => {
          if (shouldShare && this.#remoteHeadsGossipingEnabled) {
            this.#remoteHeadsSubscriptions.addGenerousPeer(peerId)
          }
        })
        .catch(err => {
          console.log("error in share policy", { err })
        })

      this.synchronizer.addPeer(peerId)
    })

    // When a peer disconnects, remove it from the synchronizer
    networkSubsystem.on("peer-disconnected", ({ peerId }) => {
      this.synchronizer.removePeer(peerId)
      this.#remoteHeadsSubscriptions.removePeer(peerId)
    })

    // Handle incoming messages
    networkSubsystem.on("message", async msg => {
      this.#receiveMessage(msg)
    })

    this.synchronizer.on("sync-state", message => {
      this.#saveSyncState(message)

      const handle = this.#handleCache[message.documentId]

      const { storageId } = this.peerMetadataByPeerId[message.peerId] || {}
      if (!storageId) {
        return
      }

      const heads = handle.getRemoteHeads(storageId)
      const haveHeadsChanged =
        message.syncState.theirHeads &&
        (!heads || !headsAreSame(heads, message.syncState.theirHeads))

      if (haveHeadsChanged && message.syncState.theirHeads) {
        handle.setRemoteHeads(storageId, message.syncState.theirHeads)

        if (storageId && this.#remoteHeadsGossipingEnabled) {
          this.#remoteHeadsSubscriptions.handleImmediateRemoteHeadsChanged(
            message.documentId,
            storageId,
            message.syncState.theirHeads
          )
        }
      }
    })

    if (this.#remoteHeadsGossipingEnabled) {
      this.#remoteHeadsSubscriptions.on("notify-remote-heads", message => {
        this.networkSubsystem.send({
          type: "remote-heads-changed",
          targetId: message.targetId,
          documentId: message.documentId,
          newHeads: {
            [message.storageId]: {
              heads: message.heads,
              timestamp: message.timestamp,
            },
          },
        })
      })

      this.#remoteHeadsSubscriptions.on("change-remote-subs", message => {
        this.#log("change-remote-subs", message)
        for (const peer of message.peers) {
          this.networkSubsystem.send({
            type: "remote-subscription-change",
            targetId: peer,
            add: message.add,
            remove: message.remove,
          })
        }
      })

      this.#remoteHeadsSubscriptions.on("remote-heads-changed", message => {
        const handle = this.#handleCache[message.documentId]
        handle.setRemoteHeads(message.storageId, message.remoteHeads)
      })
    }
  }

  // The `document` event is fired by the DocCollection any time we create a new document or look
  // up a document by ID. We listen for it in order to wire up storage and network synchronization.
  #registerHandleWithSubsystems(handle: DocHandle<any>) {
    const { storageSubsystem } = this
    if (storageSubsystem) {
      // Save when the document changes, but no more often than saveDebounceRate.
      const saveFn = ({ handle, doc }: DocHandleEncodedChangePayload<any>) => {
        void storageSubsystem.saveDoc(handle.documentId, doc)
      }
      handle.on("heads-changed", throttle(saveFn, this.saveDebounceRate))
    }

    handle.on("unavailable", () => {
      this.#log("document unavailable", { documentId: handle.documentId })
      this.emit("unavailable-document", {
        documentId: handle.documentId,
      })
    })

    // Register the document with the synchronizer. This advertises our interest in the document.
    this.synchronizer.addDocument(handle.documentId)

    // Preserve the old event in case anyone was using it.
    this.emit("document", { handle })
  }

  #receiveMessage(message: RepoMessage) {
    switch (message.type) {
      case "remote-subscription-change":
        if (this.#remoteHeadsGossipingEnabled) {
          this.#remoteHeadsSubscriptions.handleControlMessage(message)
        }
        break
      case "remote-heads-changed":
        if (this.#remoteHeadsGossipingEnabled) {
          this.#remoteHeadsSubscriptions.handleRemoteHeads(message)
        }
        break
      case "sync":
      case "request":
      case "ephemeral":
      case "doc-unavailable":
        this.synchronizer.receiveMessage(message).catch(err => {
          console.log("error receiving message", { err })
        })
    }
  }

  #throttledSaveSyncStateHandlers: Record<
    StorageId,
    (payload: SyncStatePayload) => void
  > = {}

  /** saves sync state throttled per storage id, if a peer doesn't have a storage id it's sync state is not persisted */
  #saveSyncState(payload: SyncStatePayload) {
    if (!this.storageSubsystem) {
      return
    }

    const { storageId, isEphemeral } =
      this.peerMetadataByPeerId[payload.peerId] || {}

    if (!storageId || isEphemeral) {
      return
    }

    let handler = this.#throttledSaveSyncStateHandlers[storageId]
    if (!handler) {
      handler = this.#throttledSaveSyncStateHandlers[storageId] = throttle(
        ({ documentId, syncState }: SyncStatePayload) => {
          void this.storageSubsystem!.saveSyncState(
            documentId,
            storageId,
            syncState
          )
        },
        this.saveDebounceRate
      )
    }

    handler(payload)
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
    return this.synchronizer.peers
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

    this.#registerHandleWithSubsystems(handle)

    handle.update(() => {
      let nextDoc: Automerge.Doc<T>
      if (initialValue) {
        nextDoc = Automerge.from(initialValue)
      } else {
        nextDoc = Automerge.emptyChange(Automerge.init())
      }
      return nextDoc
    })

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
    const attemptLoad = this.storageSubsystem
      ? this.storageSubsystem.loadDoc(handle.documentId)
      : Promise.resolve(null)

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

  subscribeToRemotes = (remotes: StorageId[]) => {
    if (this.#remoteHeadsGossipingEnabled) {
      this.#log("subscribeToRemotes", { remotes })
      this.#remoteHeadsSubscriptions.subscribeToRemotes(remotes)
    } else {
      this.#log(
        "WARN: subscribeToRemotes called but remote heads gossiping is not enabled"
      )
    }
  }

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
    return { documents: this.synchronizer.metrics() }
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
   * A callback can be provided to implement authorization based on document ID and peer ID.
   */
  syncPolicy?: SyncPolicy

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

/** A function that determines whether we should sync a document with a peer
 *
 * @remarks
 * This function is called by the {@link Repo} every time a peer requests to
 * sync a document. If this function returns `true` the document syncs normally;
 * if `false`, it reports the document as unavailable.
 * */
export type SyncPolicy = (
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
