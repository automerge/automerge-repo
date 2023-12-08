import { next as Automerge } from "@automerge/automerge"
import debug from "debug"
import { EventEmitter } from "eventemitter3"
import {
  generateAutomergeUrl,
  interpretAsDocumentId,
  parseAutomergeUrl,
} from "./AutomergeUrl.js"
import { DocHandle, DocHandleEncodedChangePayload } from "./DocHandle.js"
import { RemoteHeadsSubscriptions } from "./RemoteHeadsSubscriptions.js"
import { headsAreSame } from "./helpers/headsAreSame.js"
import { throttle } from "./helpers/throttle.js"
import { NetworkAdapter, type PeerMetadata } from "./network/NetworkAdapter.js"
import { NetworkSubsystem } from "./network/NetworkSubsystem.js"
import { RepoMessage } from "./network/messages.js"
import { StorageAdapter } from "./storage/StorageAdapter.js"
import { StorageSubsystem } from "./storage/StorageSubsystem.js"
import { StorageId } from "./storage/types.js"
import { CollectionSynchronizer } from "./synchronizer/CollectionSynchronizer.js"
import { SyncStatePayload } from "./synchronizer/Synchronizer.js"
import type {
  AnyDocumentId,
  DocumentId,
  PeerId,
  RepoConfig,
  RepoEvents,
  SharePolicy,
} from "./types.js"

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

  /** The debounce rate is adjustable on the repo. */
  /** @hidden */
  saveDebounceRate = 100

  #handles: Record<DocumentId, DocHandle<any>> = {}

  #synchronizer: CollectionSynchronizer

  /** By default, we share generously with all peers. */
  /** @hidden */
  sharePolicy: SharePolicy = async () => true

  /** Maps peer id to to persistence information (storageId, isEphemeral). This is used by `CollectionSynchronizer`. */
  /** @hidden */
  peerMetadata: Record<PeerId, PeerMetadata> = {}

  #remoteHeadsSubscriptions = new RemoteHeadsSubscriptions()

  #syncStateHandlers: Record<StorageId, SyncStateHandler> = {}

  constructor({
    storage,
    network,
    peerId,
    sharePolicy,
    isEphemeral = storage === undefined,
  }: RepoConfig) {
    super()
    this.#log = debug(`automerge-repo:repo`)

    // add automatic logging to all events
    this.emit = (event, ...args) => {
      this.#log(`${event} %o`, args)
      return super.emit(event, ...args)
    }

    this.sharePolicy = sharePolicy ?? this.sharePolicy

    // SYNCHRONIZER
    // The synchronizer uses the network subsystem to keep documents in sync with peers.
    this.#synchronizer = new CollectionSynchronizer(this)

    // When the synchronizer emits messages, send them to peers
    this.#synchronizer.on("message", message => {
      this.#log(`sending ${message.type} message to ${message.targetId}`)
      networkSubsystem.send(message)
    })

    // STORAGE
    // The storage subsystem has access to some form of persistence, and deals with save and loading documents.
    const storageSubsystem = storage ? new StorageSubsystem(storage) : undefined
    this.storageSubsystem = storageSubsystem

    // NETWORK
    // The network subsystem deals with sending and receiving messages to and from peers.

    const getMyPeerMetadata = async () => {
      const storageId = await storageSubsystem?.id()
      return { storageId, isEphemeral } as PeerMetadata
    }
    const myPeerMetadata: Promise<PeerMetadata> = getMyPeerMetadata()

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
        this.peerMetadata[peerId] = { ...peerMetadata }
      }

      this.sharePolicy(peerId)
        .then(shouldShare => {
          if (shouldShare) {
            this.#remoteHeadsSubscriptions.addGenerousPeer(peerId)
          }
        })
        .catch(err => {
          console.log("error in share policy", { err })
        })

      this.#synchronizer.addPeer(peerId)
    })

    // When a peer disconnects, remove it from the synchronizer
    networkSubsystem.on("peer-disconnected", ({ peerId }) => {
      this.#synchronizer.removePeer(peerId)
      this.#remoteHeadsSubscriptions.removePeer(peerId)
    })

    // Handle incoming messages
    networkSubsystem.on("message", async msg => {
      this.#receiveMessage(msg)
    })

    this.#synchronizer.on("sync-state", ({ documentId, peerId, syncState }) => {
      this.#saveSyncState({ documentId, peerId, syncState })
      const { theirHeads } = syncState
      const handle = this.#handles[documentId]

      const { storageId } = this.peerMetadata[peerId] || {}
      if (!storageId) {
        return
      }

      const prevHeads = handle.getRemoteHeads(storageId)
      const headsChanged =
        theirHeads && (!prevHeads || !headsAreSame(prevHeads, theirHeads))

      if (headsChanged) {
        handle.setRemoteHeads(storageId, theirHeads)

        if (storageId) {
          this.#remoteHeadsSubscriptions.handleImmediateRemoteHeadsChanged(
            documentId,
            storageId,
            theirHeads
          )
        }
      }
    })

    this.#remoteHeadsSubscriptions.on(
      "notify-remote-heads",
      ({ targetId, documentId, storageId, heads, timestamp }) =>
        this.networkSubsystem.send({
          type: "remote-heads-changed",
          targetId,
          documentId,
          newHeads: { [storageId]: { heads, timestamp } },
        })
    )

    this.#remoteHeadsSubscriptions.on(
      "change-remote-subs",
      ({ peers, add, remove }) => {
        for (const targetId of peers)
          this.networkSubsystem.send({
            type: "remote-subscription-change",
            targetId,
            add,
            remove,
          })
      }
    )

    this.#remoteHeadsSubscriptions.on(
      "remote-heads-changed",
      ({ documentId, remoteHeads, storageId }) =>
        this.#handles[documentId].setRemoteHeads(storageId, remoteHeads)
    )
  }

  /**
   * When we create a new document or look up a document by ID, wire up storage and network
   * synchronization.
   */
  async #registerHandle<T>(params: { handle: DocHandle<T>; isNew: boolean }) {
    const { handle, isNew } = params
    const { documentId } = handle

    const storageSubsystem = this.storageSubsystem
    if (storageSubsystem) {
      // Save when the document changes, but no more often than saveDebounceRate.
      const saveFn = ({ handle, doc }: DocHandleEncodedChangePayload<any>) => {
        void storageSubsystem.saveDoc(handle.documentId, doc)
      }
      const debouncedSaveFn = handle.on(
        "heads-changed",
        throttle(saveFn, this.saveDebounceRate)
      )

      if (isNew) {
        // this is a new document, immediately save it
        await storageSubsystem.saveDoc(handle.documentId, handle.docSync()!)
      } else {
        // Try to load from disk
        const loadedDoc = await storageSubsystem.loadDoc(handle.documentId)
        if (loadedDoc) {
          handle.update(() => loadedDoc as Automerge.Doc<T>)
        }
      }
    }

    handle.on("unavailable", () => {
      this.emit("unavailable-document", {
        documentId: handle.documentId,
      })
    })

    if (this.networkSubsystem.isReady()) {
      handle.request()
    } else {
      handle.awaitNetwork()
      try {
        await this.networkSubsystem.whenReady()
        handle.networkReady()
      } catch (error) {
        this.#log("error waiting for network", { error })
      }
    }

    // Register the document with the synchronizer. This advertises our interest in the document.
    this.#synchronizer.addDocument(handle.documentId)

    // Notify the application that we have a document
    this.emit("document", { handle, isNew })
  }

  async #receiveMessage(message: RepoMessage) {
    switch (message.type) {
      case "remote-subscription-change":
        this.#remoteHeadsSubscriptions.handleControlMessage(message)
        break
      case "remote-heads-changed":
        this.#remoteHeadsSubscriptions.handleRemoteHeads(message)
        break
      case "sync":
      case "request":
      case "ephemeral":
      case "doc-unavailable":
        try {
          await this.#synchronizer.receiveMessage(message)
        } catch (err) {
          console.log("error receiving message", { err })
        }
    }
  }

  /**
   * Saves sync state throttled per storage id. If a peer doesn't have a storage id, its sync state
   * is not persisted
   */
  #saveSyncState(payload: SyncStatePayload) {
    const storage = this.storageSubsystem
    if (!storage) return

    const { storageId, isEphemeral } = this.peerMetadata[payload.peerId] || {}

    if (!storageId || isEphemeral) return

    const createHandler = () => {
      const handler = ({ documentId, syncState }: SyncStatePayload) => {
        storage.saveSyncState(documentId, storageId, syncState)
      }
      const throttledHandler = throttle(handler, this.saveDebounceRate)
      this.#syncStateHandlers[storageId] = throttledHandler
      return throttledHandler
    }

    const handler = this.#syncStateHandlers[storageId] ?? createHandler

    handler(payload)
  }

  /** Returns an existing handle if we have it; creates one otherwise. */
  #getHandle<T>(
    /** The documentId of the handle to look up or create */
    documentId: DocumentId,

    /** If we know we're creating a new document, specify this so we can have access to it immediately */
    isNew: boolean
  ) {
    // If we have the handle cached, return it
    if (this.#handles[documentId]) return this.#handles[documentId]

    // If not, create a new handle, cache it, and return it
    const handle = new DocHandle<T>(documentId, { isNew })
    this.#handles[documentId] = handle
    return handle
  }

  /** Returns all the handles we have cached. */
  get handles() {
    return this.#handles
  }

  /** Returns a list of all connected peer ids */
  get peers(): PeerId[] {
    return this.#synchronizer.peers
  }

  /**
   * Creates a new document, advertises it to the network, and returns a handle to it. The initial
   * value of the document is an empty object `{}`. Its documentId is a UUID is generated by the
   * system.
   */
  create<T>(): DocHandle<T> {
    const { documentId } = parseAutomergeUrl(generateAutomergeUrl())
    const handle = this.#getHandle<T>(documentId, true) as DocHandle<T>
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
        `Cloned handle is not yet in ready state. Try \`await handle.waitForReady()\` first.`
      )

    const sourceDoc = sourceHandle.docSync()
    if (!sourceDoc) throw new Error("Cloned handle doesn't have a document.")

    const handle = this.create<T>()

    // we replace the new document with the clone
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

    // If we have the handle cached, return it
    if (this.#handles[documentId]) {
      if (this.#handles[documentId].isUnavailable()) {
        // this ensures that the event fires after the handle has been returned
        setTimeout(() => {
          this.#handles[documentId].emit("unavailable", {
            handle: this.#handles[documentId],
          })
        })
      }
      return this.#handles[documentId]
    }

    const handle = this.#getHandle<T>(documentId, false) as DocHandle<T>
    void this.#registerHandle({ handle, isNew: false })
    return handle
  }

  delete(
    /** The url or documentId of the handle to delete */
    id: AnyDocumentId
  ) {
    const documentId = interpretAsDocumentId(id)

    // let the handle know it's been deleted
    const handle = this.#getHandle(documentId, false)
    handle.delete()

    // remove it from the cache
    delete this.#handles[documentId]

    // remove it from storage
    void this.storageSubsystem?.removeDoc(documentId)

    // TODO Pass the delete on to the network
    // synchronizer.removeDocument(documentId)

    // notify the application
    this.emit("delete-document", { documentId })
  }

  subscribeToRemotes = (remotes: StorageId[]) => {
    this.#log("subscribeToRemotes", { remotes })
    this.#remoteHeadsSubscriptions.subscribeToRemotes(remotes)
  }

  storageId = async (): Promise<StorageId | undefined> => {
    if (!this.storageSubsystem) {
      return undefined
    } else {
      return this.storageSubsystem.id()
    }
  }
}

type SyncStateHandler = (payload: SyncStatePayload) => void
