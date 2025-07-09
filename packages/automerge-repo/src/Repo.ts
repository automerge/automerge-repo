import { next as Automerge } from "@automerge/automerge/slim"
import debug from "debug"
import { EventEmitter } from "eventemitter3"
import {
  encodeHeads,
  generateAutomergeUrl,
  interpretAsDocumentId,
  isValidAutomergeUrl,
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
import { abortable, AbortOptions } from "./helpers/abortable.js"
import { FindProgress } from "./FindProgress.js"

export type FindProgressWithMethods<T> = FindProgress<T> & {
  untilReady: (allowableStates: string[]) => Promise<DocHandle<T>>
  peek: () => FindProgress<T>
  subscribe: (callback: (progress: FindProgress<T>) => void) => () => void
}

export type ProgressSignal<T> = {
  peek: () => FindProgress<T>
  subscribe: (callback: (progress: FindProgress<T>) => void) => () => void
  untilReady: (allowableStates: string[]) => Promise<DocHandle<T>>
}

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

  /** @hidden */
  #saveDebounceRate: number

  /** @hidden */
  #saveFn: (payload: DocHandleEncodedChangePayload<any>) => void

  #handleCache: Record<DocumentId, DocHandle<any>> = {}

  /** @hidden */
  synchronizer: CollectionSynchronizer

  /** By default, we share generously with all peers. */
  /** @hidden */
  sharePolicy: SharePolicy = async () => true

  /** maps peer id to to persistence information (storageId, isEphemeral), access by collection synchronizer  */
  /** @hidden */
  peerMetadataByPeerId: Record<PeerId, PeerMetadata> = {}

  #remoteHeadsSubscriptions = new RemoteHeadsSubscriptions()
  #remoteHeadsGossipingEnabled = false
  #progressCache: Record<DocumentId, FindProgress<any>> = {}

  constructor({
    storage,
    network = [],
    peerId = randomPeerId(),
    sharePolicy,
    isEphemeral = storage === undefined,
    enableRemoteHeadsGossiping = false,
    denylist = [],
    saveDebounceRate = 100,
  }: RepoConfig = {}) {
    super()
    this.#remoteHeadsGossipingEnabled = enableRemoteHeadsGossiping
    this.#log = debug(`automerge-repo:repo`)
    this.sharePolicy = sharePolicy ?? this.sharePolicy

    this.on("delete-document", ({ documentId }) => {
      this.synchronizer.removeDocument(documentId)

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

    this.#saveDebounceRate = saveDebounceRate

    if (this.storageSubsystem) {
      const saveFn = ({ handle, doc }: DocHandleEncodedChangePayload<any>) => {
        void this.storageSubsystem!.saveDoc(handle.documentId, doc)
      }
      // Save no more often than saveDebounceRate.
      this.#saveFn = throttle(saveFn, this.#saveDebounceRate)
    } else {
      this.#saveFn = () => {}
    }

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

      const heads = handle.getSyncInfo(storageId)?.lastHeads
      const haveHeadsChanged =
        message.syncState.theirHeads &&
        (!heads ||
          !headsAreSame(heads, encodeHeads(message.syncState.theirHeads)))

      if (haveHeadsChanged && message.syncState.theirHeads) {
        handle.setSyncInfo(storageId, {
          lastHeads: encodeHeads(message.syncState.theirHeads),
          lastSyncTimestamp: Date.now(),
        })

        if (storageId && this.#remoteHeadsGossipingEnabled) {
          this.#remoteHeadsSubscriptions.handleImmediateRemoteHeadsChanged(
            message.documentId,
            storageId,
            encodeHeads(message.syncState.theirHeads)
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

      this.#remoteHeadsSubscriptions.on(
        "remote-heads-changed",
        ({ documentId, storageId, remoteHeads, timestamp }) => {
          const handle = this.#handleCache[documentId]
          handle.setSyncInfo(storageId, {
            lastHeads: remoteHeads,
            lastSyncTimestamp: timestamp,
          })
        }
      )
    }
  }

  // The `document` event is fired by the DocCollection any time we create a new document or look
  // up a document by ID. We listen for it in order to wire up storage and network synchronization.
  #registerHandleWithSubsystems(handle: DocHandle<any>) {
    if (this.storageSubsystem) {
      // Add save function as a listener if it's not already registered
      const existingListeners = handle.listeners("heads-changed")
      if (!existingListeners.some(listener => listener === this.#saveFn)) {
        // Save when the document changes
        handle.on("heads-changed", this.#saveFn)
      }
    }

    // Register the document with the synchronizer. This advertises our interest in the document.
    this.synchronizer.addDocument(handle)
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
          console.log("error receiving message", { err, message })
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
        this.#saveDebounceRate
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
   */
  clone<T>(clonedHandle: DocHandle<T>) {
    if (!clonedHandle.isReady()) {
      throw new Error(
        `Cloned handle is not yet in ready state.
        (Try await handle.whenReady() first.)`
      )
    }

    const sourceDoc = clonedHandle.doc()
    const handle = this.create<T>()

    handle.update(() => {
      // we replace the document with the new cloned one
      return Automerge.clone(sourceDoc)
    })

    return handle
  }

  findWithProgress<T>(
    id: AnyDocumentId,
    options: AbortOptions = {}
  ): FindProgressWithMethods<T> | FindProgress<T> {
    const { signal } = options
    const { documentId, heads } = isValidAutomergeUrl(id)
      ? parseAutomergeUrl(id)
      : { documentId: interpretAsDocumentId(id), heads: undefined }

    // Check handle cache first - return plain FindStep for terminal states
    if (this.#handleCache[documentId]) {
      const handle = this.#handleCache[documentId]
      if (handle.state === UNAVAILABLE) {
        const result = {
          state: "unavailable" as const,
          error: new Error(`Document ${id} is unavailable`),
          handle,
        }
        return result
      }
      if (handle.state === DELETED) {
        const result = {
          state: "failed" as const,
          error: new Error(`Document ${id} was deleted`),
          handle,
        }
        return result
      }
      if (handle.state === READY) {
        const result = {
          state: "ready" as const,
          handle: heads ? handle.view(heads) : handle,
        }
        return result
      }
    }

    // Check progress cache for any existing signal
    const cachedProgress = this.#progressCache[documentId]
    if (cachedProgress) {
      const handle = this.#handleCache[documentId]
      // Return cached progress if we have a handle and it's either in a terminal state or loading
      if (
        handle &&
        (handle.state === READY ||
          handle.state === UNAVAILABLE ||
          handle.state === DELETED ||
          handle.state === "loading")
      ) {
        return cachedProgress as FindProgressWithMethods<T>
      }
    }

    const handle = this.#getHandle<T>({ documentId })
    const initial = {
      state: "loading" as const,
      progress: 0,
      handle,
    }

    // Create a new progress signal
    const progressSignal = {
      subscribers: new Set<(progress: FindProgress<T>) => void>(),
      currentProgress: undefined as FindProgress<T> | undefined,
      notify: (progress: FindProgress<T>) => {
        progressSignal.currentProgress = progress
        progressSignal.subscribers.forEach(callback => callback(progress))
        // Cache all states, not just terminal ones
        this.#progressCache[documentId] = progress
      },
      peek: () => progressSignal.currentProgress || initial,
      subscribe: (callback: (progress: FindProgress<T>) => void) => {
        progressSignal.subscribers.add(callback)
        return () => progressSignal.subscribers.delete(callback)
      },
    }

    progressSignal.notify(initial)

    // Start the loading process
    void this.#loadDocumentWithProgress(
      id,
      documentId,
      handle,
      progressSignal,
      signal ? abortable(new Promise(() => {}), signal) : new Promise(() => {})
    )

    const result = {
      ...initial,
      peek: progressSignal.peek,
      subscribe: progressSignal.subscribe,
    }
    this.#progressCache[documentId] = result
    return result
  }

  async #loadDocumentWithProgress<T>(
    id: AnyDocumentId,
    documentId: DocumentId,
    handle: DocHandle<T>,
    progressSignal: {
      notify: (progress: FindProgress<T>) => void
    },
    abortPromise: Promise<never>
  ) {
    try {
      progressSignal.notify({
        state: "loading" as const,
        progress: 25,
        handle,
      })

      const loadingPromise = await (this.storageSubsystem
        ? this.storageSubsystem.loadDoc(handle.documentId)
        : Promise.resolve(null))

      const loadedDoc = await Promise.race([loadingPromise, abortPromise])

      if (loadedDoc) {
        handle.update(() => loadedDoc as Automerge.Doc<T>)
        handle.doneLoading()
        progressSignal.notify({
          state: "loading" as const,
          progress: 50,
          handle,
        })
      } else {
        await Promise.race([this.networkSubsystem.whenReady(), abortPromise])
        handle.request()
        progressSignal.notify({
          state: "loading" as const,
          progress: 75,
          handle,
        })
      }

      this.#registerHandleWithSubsystems(handle)

      await Promise.race([handle.whenReady([READY, UNAVAILABLE]), abortPromise])

      if (handle.state === UNAVAILABLE) {
        const unavailableProgress = {
          state: "unavailable" as const,
          handle,
        }
        progressSignal.notify(unavailableProgress)
        return
      }
      if (handle.state === DELETED) {
        throw new Error(`Document ${id} was deleted`)
      }

      progressSignal.notify({ state: "ready" as const, handle })
    } catch (error) {
      progressSignal.notify({
        state: "failed" as const,
        error: error instanceof Error ? error : new Error(String(error)),
        handle: this.#getHandle<T>({ documentId }),
      })
    }
  }

  async find<T>(
    id: AnyDocumentId,
    options: RepoFindOptions & AbortOptions = {}
  ): Promise<DocHandle<T>> {
    const { allowableStates = ["ready"], signal } = options

    // Check if already aborted
    if (signal?.aborted) {
      throw new Error("Operation aborted")
    }

    const progress = this.findWithProgress<T>(id, { signal })

    if ("subscribe" in progress) {
      this.#registerHandleWithSubsystems(progress.handle)
      return new Promise((resolve, reject) => {
        const unsubscribe = progress.subscribe(state => {
          if (allowableStates.includes(state.handle.state)) {
            unsubscribe()
            resolve(state.handle)
          } else if (state.state === "unavailable") {
            unsubscribe()
            reject(new Error(`Document ${id} is unavailable`))
          } else if (state.state === "failed") {
            unsubscribe()
            reject(state.error)
          }
        })
      })
    } else {
      if (progress.handle.state === READY) {
        return progress.handle
      }
      // If the handle isn't ready, wait for it and then return it
      await progress.handle.whenReady([READY, UNAVAILABLE])
      if (
        progress.handle.state === "unavailable" &&
        !allowableStates.includes(UNAVAILABLE)
      ) {
        throw new Error(`Document ${id} is unavailable`)
      }
      return progress.handle
    }
  }

  /**
   * Loads a document without waiting for ready state
   */
  async #loadDocument<T>(documentId: DocumentId): Promise<DocHandle<T>> {
    // If we have the handle cached, return it
    if (this.#handleCache[documentId]) {
      return this.#handleCache[documentId]
    }

    // If we don't already have the handle, make an empty one and try loading it
    const handle = this.#getHandle<T>({ documentId })
    const loadedDoc = await (this.storageSubsystem
      ? this.storageSubsystem.loadDoc(handle.documentId)
      : Promise.resolve(null))

    if (loadedDoc) {
      // We need to cast this to <T> because loadDoc operates in <unknowns>.
      // This is really where we ought to be validating the input matches <T>.
      handle.update(() => loadedDoc as Automerge.Doc<T>)
      handle.doneLoading()
    } else {
      // Because the network subsystem might still be booting up, we wait
      // here so that we don't immediately give up loading because we're still
      // making our initial connection to a sync server.
      await this.networkSubsystem.whenReady()
      handle.request()
    }

    this.#registerHandleWithSubsystems(handle)
    return handle
  }

  /**
   * Retrieves a document by id. It gets data from the local system, but also emits a `document`
   * event to advertise interest in the document.
   */
  async findClassic<T>(
    /** The url or documentId of the handle to retrieve */
    id: AnyDocumentId,
    options: RepoFindOptions & AbortOptions = {}
  ): Promise<DocHandle<T>> {
    const documentId = interpretAsDocumentId(id)
    const { allowableStates, signal } = options

    return abortable(
      (async () => {
        const handle = await this.#loadDocument<T>(documentId)
        if (!allowableStates) {
          await handle.whenReady([READY, UNAVAILABLE])
          if (handle.state === UNAVAILABLE && !signal?.aborted) {
            throw new Error(`Document ${id} is unavailable`)
          }
        }
        return handle
      })(),
      signal
    )
  }

  delete(
    /** The url or documentId of the handle to delete */
    id: AnyDocumentId
  ) {
    const documentId = interpretAsDocumentId(id)

    const handle = this.#getHandle({ documentId })
    handle.delete()

    delete this.#handleCache[documentId]
    delete this.#progressCache[documentId]
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
    const doc = handle.doc()
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
        return this.storageSubsystem!.saveDoc(handle.documentId, handle.doc())
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
    await handle.whenReady([READY, UNLOADED, DELETED, UNAVAILABLE])
    const doc = handle.doc()
    // because this is an internal-ish function, we'll be extra careful about undefined docs here
    if (doc) {
      if (handle.isReady()) {
        handle.unload()
      } else {
        this.#log(
          `WARN: removeFromCache called but handle for documentId: ${documentId} in unexpected state: ${handle.state}`
        )
      }
      delete this.#handleCache[documentId]
      delete this.#progressCache[documentId]
      this.synchronizer.removeDocument(documentId)
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
   * Whether to enable the experimental remote heads gossiping feature
   */
  enableRemoteHeadsGossiping?: boolean

  /**
   * A list of automerge URLs which should never be loaded regardless of what
   * messages are received or what the share policy is. This is useful to avoid
   * loading documents that are known to be too resource intensive.
   */
  denylist?: AutomergeUrl[]

  /**
   * The debounce rate in milliseconds for saving documents. Defaults to 100ms.
   */
  saveDebounceRate?: number
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

export interface RepoFindOptions {
  allowableStates?: string[]
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
