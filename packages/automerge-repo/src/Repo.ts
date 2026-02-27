import { next as Automerge, Heads } from "@automerge/automerge/slim"
import debug from "debug"
import { EventEmitter } from "eventemitter3"
import {
  binaryToDocumentId,
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
import { HashRing } from "./helpers/HashRing.js"
import {
  automergeMeta,
  toDocumentId,
  toSedimentreeId,
  toSubductionPeerId,
  _setSubductionModuleForHelpers,
} from "./helpers/subduction.js"
import { RemoteHeadsSubscriptions } from "./RemoteHeadsSubscriptions.js"
import { headsAreSame } from "./helpers/headsAreSame.js"
import { throttle, ThrottledFunction } from "./helpers/throttle.js"
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
import { DocSyncMetrics } from "./synchronizer/Synchronizer.js"
import type {
  AnyDocumentId,
  AutomergeUrl,
  BinaryDocumentId,
  DocumentId,
  PeerId,
} from "./types.js"
import { abortable, AbortOptions, AbortError } from "./helpers/abortable.js"
import { FindProgress, type FindProgressWithMethods } from "./FindProgress.js"
// Type-only imports (don't trigger Wasm access)
import type {
  Digest as DigestType,
  FragmentStateStore as FragmentStateStoreType,
  HashMetric as HashMetricType,
  SedimentreeAutomerge as SedimentreeAutomergeType,
  SedimentreeId,
  SedimentreeStorage,
  Subduction,
} from "@automerge/automerge-subduction"

// Runtime constructors are lazy-loaded to avoid accessing Wasm before initialization
// The module reference is set by setSubductionModule() before Repo construction
let _subductionModule: typeof import("@automerge/automerge-subduction") | null =
  null

/**
 * Set the subduction module reference. Must be called after Wasm initialization
 * but before constructing a Repo.
 *
 * @example
 * ```ts
 * import { initSync } from "@automerge/automerge-subduction"
 * import * as subductionModule from "@automerge/automerge-subduction"
 * import { setSubductionModule } from "@automerge/automerge-repo"
 *
 * await initSync()
 * setSubductionModule(subductionModule)
 * // Now you can construct a Repo
 * ```
 */
export function setSubductionModule(
  module: typeof import("@automerge/automerge-subduction")
): void {
  _subductionModule = module
  _setSubductionModuleForHelpers(module)
}

function getSubductionModule(): typeof import("@automerge/automerge-subduction") {
  if (_subductionModule === null) {
    throw new Error(
      "Subduction module not set. Call setSubductionModule() after Wasm initialization."
    )
  }
  return _subductionModule
}

// Convenience getters for commonly used constructors
function getDigest(): typeof DigestType {
  return getSubductionModule().Digest as unknown as typeof DigestType
}

function getHashMetricClass(): new (arg: null) => HashMetricType {
  return getSubductionModule().HashMetric as unknown as new (
    arg: null
  ) => HashMetricType
}

function getFragmentStateStoreClass(): new () => FragmentStateStoreType {
  return getSubductionModule()
    .FragmentStateStore as unknown as new () => FragmentStateStoreType
}

function getSedimentreeAutomergeClass(): new (
  doc: any
) => SedimentreeAutomergeType {
  return getSubductionModule().SedimentreeAutomerge as unknown as new (
    doc: any
  ) => SedimentreeAutomergeType
}

/**
 * Interface for storage bridges that support event callbacks.
 * This allows Repo to register callbacks without depending on the concrete bridge implementation.
 */
export interface SubductionStorageWithCallbacks extends SedimentreeStorage {
  on(
    event: "commit-saved",
    callback: (
      sedimentreeId: SedimentreeId,
      digest: DigestType,
      blob: Uint8Array
    ) => void
  ): void
  on(
    event: "fragment-saved",
    callback: (
      sedimentreeId: SedimentreeId,
      digest: DigestType,
      blob: Uint8Array
    ) => void
  ): void
  off(
    event: "commit-saved",
    callback: (
      sedimentreeId: SedimentreeId,
      digest: DigestType,
      blob: Uint8Array
    ) => void
  ): void
  off(
    event: "fragment-saved",
    callback: (
      sedimentreeId: SedimentreeId,
      digest: DigestType,
      blob: Uint8Array
    ) => void
  ): void
  /**
   * Wait for all pending save operations to complete.
   */
  awaitSettled(): Promise<void>
}

function randomPeerId() {
  return ("peer-" + Math.random().toString(36).slice(4)) as PeerId
}

// Lazy-initialize HashMetric to avoid accessing WASM before it's loaded
let _hashMetric: HashMetricType | null = null
function getHashMetric(): HashMetricType {
  if (_hashMetric === null) {
    const HashMetricCtor = getHashMetricClass()
    _hashMetric = new HashMetricCtor(null)
  }
  return _hashMetric
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

  /** Subduction */
  #subduction: Subduction
  #subductionStorage: SubductionStorageWithCallbacks | null = null
  #handlesBySedimentreeId: Map<string, DocHandle<any>> // NOTE until doc IDs are [u8; 32]s
  #fragmentStateStore: FragmentStateStoreType
  #lastHeadsSent: Map<string, Set<string>> // TODO move to subduction.wasm
  #recentlySeenHeads: Map<string, HashRing>
  #recentHeadsCacheSize: number

  /** Tracks pending outbound operations for awaitOutbound() */
  #pendingOutbound: number = 0
  #outboundResolvers: (() => void)[] = []
  #throttledBroadcasts: ThrottledFunction<() => void>[] = []

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

  #shareConfig: ShareConfig = {
    announce: async () => true,
    access: async () => true,
  }

  /** maps peer id to to persistence information (storageId, isEphemeral), access by collection synchronizer  */
  /** @hidden */
  peerMetadataByPeerId: Record<PeerId, PeerMetadata> = {}

  #remoteHeadsSubscriptions = new RemoteHeadsSubscriptions()
  #remoteHeadsGossipingEnabled = false
  #progressCache: Record<DocumentId, FindProgress<any>> = {}
  #saveFns: Record<
    DocumentId,
    (payload: DocHandleEncodedChangePayload<any>) => void
  > = {}
  #idFactory: ((initialHeads: Heads) => Promise<Uint8Array>) | null

  constructor({
    storage,
    network = [],
    peerId = randomPeerId(),
    sharePolicy,
    shareConfig,
    isEphemeral = storage === undefined,
    enableRemoteHeadsGossiping = false,
    denylist = [],
    saveDebounceRate = 100,
    idFactory,
    subduction,
    recentHeadsCacheSize = 256,
  }: RepoConfig) {
    super()
    this.#remoteHeadsGossipingEnabled = enableRemoteHeadsGossiping
    this.#log = debug(`automerge-repo:repo`)

    this.#idFactory = idFactory || null
    // Handle legacy sharePolicy
    if (sharePolicy != null && shareConfig != null) {
      throw new Error("cannot provide both sharePolicy and shareConfig at once")
    }
    if (sharePolicy) {
      this.#shareConfig = {
        announce: sharePolicy,
        access: async () => true,
      }
    }
    if (shareConfig) {
      this.#shareConfig = shareConfig
    }

    this.on("delete-document", ({ documentId }) => {
      this.#subduction.removeSedimentree(toSedimentreeId(documentId))
    })

    this.synchronizer = new CollectionSynchronizer(this, denylist)

    // When the synchronizer emits messages, send them to peers
    this.synchronizer.on("message", message => {
      this.#log(`sending ${message.type} message to ${message.targetId}`)
      networkSubsystem.send(message)
    })

    // STORAGE
    // The storage subsystem has access to some form of persistence, and deals with save and loading documents.
    const storageSubsystem = storage ? new StorageSubsystem(storage) : undefined
    if (storageSubsystem) {
      storageSubsystem.on("document-loaded", event =>
        this.emit("doc-metrics", { type: "doc-loaded", ...event })
      )
      storageSubsystem.on("doc-compacted", event =>
        this.emit("doc-metrics", { type: "doc-compacted", ...event })
      )
      storageSubsystem.on("doc-saved", event =>
        this.emit("doc-metrics", { type: "doc-saved", ...event })
      )
    }

    this.storageSubsystem = storageSubsystem

    this.#saveDebounceRate = saveDebounceRate

    if (this.storageSubsystem) {
      // Save no more often than saveDebounceRate.
      this.#saveFn = ({ handle, doc }: DocHandleEncodedChangePayload<any>) => {
        let fn = this.#saveFns[handle.documentId]
        if (!fn) {
          fn = throttle(
            ({ doc, handle }: DocHandleEncodedChangePayload<any>) => {
              void this.storageSubsystem!.saveDoc(handle.documentId, doc)
            },
            this.#saveDebounceRate
          )
          this.#saveFns[handle.documentId] = fn
        }
        fn({ handle, doc })
      }
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

      this.#shareConfig
        .announce(peerId)
        .then(shouldShare => {
          if (shouldShare && this.#remoteHeadsGossipingEnabled) {
            this.#remoteHeadsSubscriptions.addGenerousPeer(peerId)
          }
        })
        .catch(err => {
          this.#log("error in share policy", { err })
        })

      this.synchronizer.addPeer(peerId)
    })

    // When a peer disconnects, remove it from the synchronizer
    networkSubsystem.on("peer-disconnected", ({ peerId }) => {
      this.synchronizer.removePeer(peerId)
      this.#disconnectFromPeer(peerId)
      this.#remoteHeadsSubscriptions.removePeer(peerId)
    })

    // Handle incoming messages
    networkSubsystem.on("message", async msg => {
      this.#receiveMessage(msg)
    })

    this.synchronizer.on("sync-state", message => {
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

    this.#subduction = subduction
    const FragmentStateStoreCtor = getFragmentStateStoreClass()
    this.#fragmentStateStore = new FragmentStateStoreCtor()
    this.#recentHeadsCacheSize = recentHeadsCacheSize
    this.#recentlySeenHeads = new Map()
    this.#lastHeadsSent = new Map()
    this.#handlesBySedimentreeId = new Map()

    if (hasCallbacks(subduction.storage)) {
      const subductionStorage = subduction.storage
      this.#subductionStorage = subductionStorage

      subductionStorage.on("commit-saved", (id, digest, blob) => {
        this.#handleCommitSaved(id, digest, blob)
      })

      subductionStorage.on("fragment-saved", (id, digest, blob) => {
        this.#handleFragmentSaved(id, digest, blob)
      })
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

    this.#tellSubductionAboutNewHandle(handle)

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
          this.#log("error receiving message", { err, message })
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
  }): DocHandle<T> {
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

  /** Returns the local peer id */
  get peerId(): PeerId {
    return this.networkSubsystem.peerId
  }

  /** @hidden */
  get sharePolicy(): SharePolicy {
    return this.#shareConfig.announce
  }

  /** @hidden */
  set sharePolicy(policy: SharePolicy) {
    this.#shareConfig.announce = policy
  }

  /** @hidden */
  get shareConfig(): ShareConfig {
    return this.#shareConfig
  }

  /** @hidden */
  set shareConfig(config: ShareConfig) {
    this.#shareConfig = config
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
    let initialDoc: Automerge.Doc<T>
    if (initialValue) {
      initialDoc = Automerge.from(initialValue)
    } else {
      initialDoc = Automerge.emptyChange(Automerge.init())
    }

    // Generate a new UUID and store it in the buffer
    const { documentId } = parseAutomergeUrl(generateAutomergeUrl())
    const handle = this.#getHandle<T>({
      documentId,
    }) as DocHandle<T>

    handle.update(() => initialDoc)
    this.#registerHandleWithSubsystems(handle)

    handle.doneLoading()

    // Sync the new document to peers (fire-and-forget since create is sync)
    // This ensures peers receive the initial data and establishes subscriptions
    const sid = toSedimentreeId(documentId)
    void this.#subduction.syncAll(sid, true)

    return handle
  }

  /**
   * Creates a new document and returns a handle to it. The initial value of the
   * document is an empty object `{}` unless an initial value is provided. The
   * main difference between this and Repo.create is that if an `idGenerator`
   * was provided at repo construction, that idGenerator will be used to
   * generate the document ID of the document returned by this method.
   *
   * This is a hidden, experimental API which is subject to change or removal without notice.
   * @hidden
   * @experimental
   */
  async create2<T>(initialValue?: T): Promise<DocHandle<T>> {
    // Note that the reason this method is hidden and experimental is because it is async,
    // and it is async because we want to be able to call the #idGenerator, which is async.
    // This is all really in service of wiring up keyhive and we probably need to find a
    // nicer way to achieve this.
    let initialDoc: Automerge.Doc<T>
    if (initialValue) {
      initialDoc = Automerge.from(initialValue)
    } else {
      initialDoc = Automerge.emptyChange(Automerge.init())
    }

    let { documentId } = parseAutomergeUrl(generateAutomergeUrl())
    if (this.#idFactory) {
      const rawDocId = await this.#idFactory(Automerge.getHeads(initialDoc))
      documentId = binaryToDocumentId(rawDocId as BinaryDocumentId)
    }
    const handle = this.#getHandle<T>({
      documentId,
    }) as DocHandle<T>

    handle.update(() => initialDoc)
    this.#registerHandleWithSubsystems(handle)
    handle.doneLoading()

    const sid = toSedimentreeId(documentId)
    this.#subduction.syncAll(sid, true)
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

      const sedimentreeId = toSedimentreeId(handle.documentId)
      const loadedBlobs = await Promise.race([
        this.#subduction.getBlobs(sedimentreeId),
        abortPromise,
      ])

      if (!!loadedBlobs && loadedBlobs.length > 0) {
        handle.update(doc => {
          let newDoc = doc
          loadedBlobs.forEach((blob: Uint8Array) => {
            newDoc = Automerge.loadIncremental(newDoc, blob)
          })
          return newDoc
        })
        handle.doneLoading()
        progressSignal.notify({
          state: "loading" as const,
          progress: 50,
          handle,
        })
      } else {
        await Promise.race([
          this.#requestDocOverSubduction(handle),
          abortPromise,
        ])
        // Only call request() if Subduction didn't already load the data
        // The storage callback may have called doneLoading() during requestDocOverSubduction
        if (!handle.isReady()) {
          handle.request()
        }
        progressSignal.notify({
          state: "loading" as const,
          progress: 75,
          handle,
        })
      }

      await this.#requestDocOverSubduction(handle)
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
        error:
          // In most JS environments DOMException extends Error, but not always, in some environments it's a separate type.
          // Some Node.js DOM polyfills do not always extend the Error
          // Jsdom polyfill doesn't extend Error, whereas happy-dom does.
          error instanceof Error || error instanceof DOMException
            ? error
            : new Error(String(error)),
        handle: this.#getHandle<T>({ documentId }),
      })
    }
  }

  async find<T>(
    id: AnyDocumentId,
    options: RepoFindOptions & AbortOptions = {}
  ): Promise<DocHandle<T>> {
    const { allowableStates = [READY], signal } = options

    // Check if already aborted
    if (signal?.aborted) {
      throw new AbortError()
    }

    const progress = this.findWithProgress<T>(id, { signal })

    if ("subscribe" in progress) {
      this.#registerHandleWithSubsystems(progress.handle)
      const targetDocumentId = progress.handle.documentId

      return new Promise((resolve, reject) => {
        let resolved = false

        const cleanup = () => {
          if (!resolved) {
            resolved = true
            unsubscribe()
            this.off("document", onDocument)
          }
        }

        // Listen for the document event - this fires when a document becomes
        // available via async sync (e.g., Subduction)
        const onDocument = ({ handle }: { handle: DocHandle<unknown> }) => {
          if (
            handle.documentId === targetDocumentId &&
            allowableStates.includes(handle.state)
          ) {
            cleanup()
            resolve(handle as DocHandle<T>)
          }
        }

        const unsubscribe = progress.subscribe((state: FindProgress<T>) => {
          if (allowableStates.includes(state.handle.state)) {
            cleanup()
            resolve(state.handle)
          } else if (state.state === "unavailable") {
            // Don't reject on unavailable - the document may become available
            // via async sync (e.g., Subduction). Keep listening for the
            // "document" event which will fire when the data arrives.
          } else if (state.state === "failed") {
            cleanup()
            reject(state.error)
          }
        })

        this.on("document", onDocument)
      })
    } else {
      if (allowableStates.includes(progress.handle.state)) {
        return progress.handle
      }
      // If the handle isn't ready, wait for it and then return it
      await progress.handle.whenReady([READY, UNAVAILABLE])
      if (
        progress.handle.state === UNAVAILABLE &&
        !allowableStates.includes(UNAVAILABLE)
      ) {
        throw new Error(`Document ${id} is unavailable`)
      }
      return progress.handle
    }
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
    delete this.#saveFns[documentId]
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
   * @param args - Optional argument specifying what document ID to import into,
   *              if at all possible avoid using this, see the remarks below
   *
   * @remarks
   * If no document ID is provided, a new document will be created. When
   * specifying the document ID it is important to ensure that two documents using
   * the same ID share the same history - i.e. don't create a document with the
   * same ID on unrelated processes that have never communicated with each
   * other. If you need to ship around a bunch of documents with their IDs
   * consider using the `automerge-repo-bundles` package which provides a
   * serialization format for documents and IDs and handles the boilerplate of
   * importing and exporting these bundles.
   */
  import<T>(binary: Uint8Array, args?: { docId?: DocumentId }): DocHandle<T> {
    const docId = args?.docId
    if (docId != null) {
      const handle = this.#getHandle<T>({ documentId: docId })
      handle.update(doc => {
        return Automerge.loadIncremental(doc, binary)
      })
      this.#registerHandleWithSubsystems(handle)
      return handle
    } else {
      const doc = Automerge.load<T>(binary)
      const handle = this.create<T>()
      handle.update(() => {
        return Automerge.clone(doc)
      })

      return handle
    }
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
    const handles = documents
      ? documents
          .map(id => this.#handleCache[id])
          .filter(handle => handle.isReady())
      : Object.values(this.#handleCache)
    await Promise.all(
      handles.map(async handle => {
        const sid = toSedimentreeId(handle.documentId)
        if (handle.isReady()) {
          await this.#broadcast(handle.doc(), sid)
        }
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
      await this.#subduction.removeSedimentree(toSedimentreeId(documentId))
      delete this.#handleCache[documentId]
      delete this.#progressCache[documentId]
      delete this.#saveFns[documentId]
    } else {
      this.#log(
        `WARN: removeFromCache called but doc undefined for documentId: ${documentId}`
      )
    }
  }

  /**
   * Wait for all pending outbound operations to complete.
   * Call this before shutdown() to ensure all changes have been sent to the network.
   */
  async awaitOutbound(): Promise<void> {
    // Flush any pending throttled broadcasts first
    for (const throttled of this.#throttledBroadcasts) {
      throttled.flush()
    }

    // Yield to let flushed broadcasts start executing
    await Promise.resolve()

    if (this.#pendingOutbound === 0) return
    return new Promise(resolve => this.#outboundResolvers.push(resolve))
  }

  async shutdown() {
    await this.awaitOutbound()
    await this.#subduction.disconnectAll()
    await this.flush()
  }

  /**
   * Sync all known documents with the server.
   * Call this before change detection to ensure all remote commits are received.
   */
  async syncAllDocuments(): Promise<void> {
    // Get all known sedimentree IDs
    const sedimentreeIds = Array.from(this.#handlesBySedimentreeId.keys())

    // Sync each sequentially to avoid overwhelming the server
    for (const sidStr of sedimentreeIds) {
      const handle = this.#handlesBySedimentreeId.get(sidStr)
      if (handle) {
        await this.#requestDocOverSubduction(handle)
      }
    }
  }

  metrics(): { documents: { [key: string]: any } } {
    return { documents: this.synchronizer.metrics() }
  }

  shareConfigChanged() {
    void this.synchronizer.reevaluateDocumentShare()
  }

  #disconnectFromPeer(peerId: PeerId) {
    const subductionPeerId = toSubductionPeerId(peerId)
    this.#subduction.disconnectFromPeer(subductionPeerId)
  }

  async #requestDocOverSubduction(handle: DocHandle<any>) {
    const sedimentreeId = toSedimentreeId(handle.documentId)
    this.#handlesBySedimentreeId.set(sedimentreeId.toString(), handle)

    // With the 1.5RTT protocol, syncAll performs bidirectional sync in a single call:
    // 1. We send our summary to peers
    // 2. Peers respond with data we're missing AND tell us what they need
    // 3. We send back what they requested (handled internally by Subduction)
    this.#log(`syncing sedimentree ${sedimentreeId.toString().slice(0, 8)}...`)
    const peerResultMap = await this.#subduction.syncAll(sedimentreeId, true)

    // Log sync statistics and any errors
    for (const result of peerResultMap.entries()) {
      const stats = result.stats
      if (stats && !stats.isEmpty) {
        this.#log(
          `sync stats: received ${stats.commitsReceived} commits, ${stats.fragmentsReceived} fragments; ` +
            `sent ${stats.commitsSent} commits, ${stats.fragmentsSent} fragments`
        )
      }
      if (!result.success) {
        this.#log("sync failed for peer")
      }
      for (const errPair of result.connErrors || []) {
        this.#log("sync connection error:", errPair.err)
      }
    }

    // Wait for storage callbacks to complete before transitioning to ready
    if (this.#subductionStorage) {
      await this.#subductionStorage.awaitSettled()
    }

    // Now that all blobs have been loaded, transition the handle to READY state.
    // This must happen AFTER awaitSettled so all data is available before ready.
    const wasNotReady = !handle.isReady()
    handle.doneLoading()

    // Emit document event if this handle just transitioned to ready
    if (wasNotReady && handle.isReady()) {
      this.emit("document", { handle })
    }
  }

  #tellSubductionAboutNewHandle(handle: DocHandle<any>) {
    const sid = toSedimentreeId(handle.documentId)
    this.#handlesBySedimentreeId.set(sid.toString(), handle)

    const throttledBroadcast = throttle(() => {
      // Read the doc outside of handle.update() to avoid holding an XState
      // borrow while entering async Wasm code. The previous approach called
      // #broadcast inside handle.update(), which is synchronous — but
      // #broadcast is async and touches Wasm &mut self via buildFragmentStore.
      // When multiple handles' throttled broadcasts fire in the same microtask
      // batch, the nested borrows cause "recursive use of an object" panics.
      if (!handle.isReady()) return
      const doc = handle.doc()
      if (!doc) return
      this.#broadcast(doc, sid)
    }, 100)

    // Track for flushing in awaitOutbound()
    this.#throttledBroadcasts.push(throttledBroadcast)

    handle.on("heads-changed", () => {
      throttledBroadcast()
    })

    throttledBroadcast()
  }

  async #broadcast<T>(doc: Automerge.Doc<T>, sedimentreeId: SedimentreeId) {
    // Track this broadcast for awaitOutbound() BEFORE any awaits
    this.#pendingOutbound++

    try {
      const currentHexHeads = Automerge.getHeads(doc)
      const id = sedimentreeId.toString()
      const mostRecentHeads: Set<string> =
        this.#lastHeadsSent.get(id) || new Set()

      // Properly compare set contents (not identity)
      const currentSet = new Set(currentHexHeads)
      const headsAlreadySent =
        currentSet.size === mostRecentHeads.size &&
        [...currentSet].every(h => mostRecentHeads.has(h))
      if (headsAlreadySent) {
        return
      }

      await Promise.all(
        Automerge.getChangesMetaSince(doc, Array.from(mostRecentHeads)).map(
          async meta => {
            try {
              const cache =
                this.#recentlySeenHeads.get(id) ||
                new HashRing(this.#recentHeadsCacheSize)

              const hexHash = meta.hash
              if (!cache.add(hexHash)) return

              this.#recentlySeenHeads.set(id, cache)

              const commitBytes = automergeMeta(doc).getChangeByHash(hexHash)
              const Digest = getDigest()
              const parents = meta.deps.map(depHexHash =>
                Digest.fromHexString(depHexHash)
              )

              const maybeFragmentRequested = await this.#subduction.addCommit(
                sedimentreeId,
                parents,
                commitBytes
              )

              if (maybeFragmentRequested === undefined) return

              const fragmentRequested = maybeFragmentRequested
              const head = fragmentRequested.head
              if (!head || !(head as any).__wbg_ptr) {
                this.#log(
                  "skipping buildFragmentStore: fragmentRequested.head is invalid (ptr=%s)",
                  (head as any)?.__wbg_ptr
                )
                return
              }

              const innerDoc = automergeMeta(doc)
              const SedimentreeAutomergeCtor = getSedimentreeAutomergeClass()
              const sam = new SedimentreeAutomergeCtor(innerDoc)

              // Build all missing fragments recursively, not just the top one.
              const fragmentStates = sam.buildFragmentStore(
                [head],
                this.#fragmentStateStore,
                getHashMetric()
              )

              for (const fragmentState of fragmentStates) {
                const members = fragmentState
                  .members()
                  .map((digest: DigestType): string => digest.toHexString())

                // NOTE this is the only(?) function that we need from AM v3.2.0
                const fragmentBlob = Automerge.saveBundle(doc, members)

                await this.#subduction.addFragment(
                  sedimentreeId,
                  fragmentState.head_digest(),
                  fragmentState.boundary().keys(),
                  fragmentState.checkpoints(),
                  fragmentBlob
                )
              }
            } catch (e) {
              // Best-effort: if addCommit or buildFragmentStore fails (e.g.,
              // partial history, detached Wasm memory), log and continue.
              // Commits are still stored; fragment compaction will retry later.
              console.warn(
                `[Repo] broadcast failed for change ${meta.hash} on ${id}:`,
                e
              )
            }
          }
        )
      )

      this.#lastHeadsSent.set(sedimentreeId.toString(), currentSet)
    } finally {
      this.#pendingOutbound--
      if (this.#pendingOutbound === 0) {
        this.#outboundResolvers.forEach(r => r())
        this.#outboundResolvers = []
      }
    }
  }

  /**
   * Handle a commit being saved to storage.
   * Called via storage bridge callback after data is persisted.
   */
  #handleCommitSaved(id: SedimentreeId, _digest: DigestType, blob: Uint8Array) {
    const existingHandle = this.#handlesBySedimentreeId.get(id.toString())
    if (existingHandle !== undefined) {
      // Only update the document - don't call doneLoading() here.
      // During batch sync, multiple blobs arrive asynchronously.
      // Calling doneLoading() on each blob would transition to READY too early.
      // Instead, #requestDocOverSubduction calls doneLoading() after syncAll + awaitSettled.
      existingHandle.update(doc => Automerge.loadIncremental(doc, blob))
    } else {
      // New sedimentree we haven't seen before - create a handle for it
      const documentId = toDocumentId(id)
      const handle = this.#getHandle({ documentId })
      this.#handlesBySedimentreeId.set(id.toString(), handle)
      handle.update(doc => Automerge.loadIncremental(doc, blob))
      // Don't call doneLoading() or emit document event here.
      // This will be done by #requestDocOverSubduction after batch sync completes.
    }
  }

  /**
   * Handle a fragment being saved to storage.
   * Called via storage bridge callback after data is persisted.
   */
  #handleFragmentSaved(
    id: SedimentreeId,
    _digest: DigestType,
    blob: Uint8Array
  ) {
    const existingHandle = this.#handlesBySedimentreeId.get(id.toString())
    if (existingHandle !== undefined) {
      // Only update the document - don't call doneLoading() here.
      // See comment in #handleCommitSaved for rationale.
      existingHandle.update(doc => Automerge.loadIncremental(doc, blob))
    } else {
      // New sedimentree we haven't seen before - create a handle for it
      const documentId = toDocumentId(id)
      const handle = this.#getHandle({ documentId })
      this.#handlesBySedimentreeId.set(id.toString(), handle)
      handle.update(doc => Automerge.loadIncremental(doc, blob))
      // Don't call doneLoading() or emit document event here.
      // This will be done by #requestDocOverSubduction after batch sync completes.
    }
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
   * Whether to share documents with other peers. By default we announce new
   * documents to everyone and allow everyone access to documents, see the
   * documentation for {@link ShareConfig} to override this
   *
   * Note that this is currently an experimental API and will very likely change
   * without a major release.
   * @experimental
   */
  shareConfig?: ShareConfig

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

  // This is hidden for now because it's an experimental API, mostly here in order
  // for keyhive to be able to control the ID generation
  /**
   * @hidden
   */
  idFactory?: (initialHeads: Heads) => Promise<Uint8Array>

  /**
   * The Subduction sync engine instance.
   *
   * @remarks
   * Create this by calling `Subduction.hydrate(signer, storage)` where `storage`
   * is a `SubductionStorageBridge` wrapping your storage adapter. The bridge package
   * provides a `setupSubduction()` helper to simplify this.
   *
   * @see {@link https://github.com/automerge/automerge-repo | automerge-repo README} for setup examples.
   */
  subduction: Subduction

  /**
   * The size of the cache for recently seen heads per document to avoid resending them
   */
  recentHeadsCacheSize?: number
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

/**
 * A type which determines whether we should share a document with a peer
 * */
export type ShareConfig = {
  /**
   * Whether we should actively announce a document to a peer

   * @remarks
   * This functions is called after checking the `access` policy to determine
   * whether we should announce a document to a connected peer. For example, a
   * tab connected to a sync server might want to announce every document to the
   * sync server, but the sync server would not want to announce every document
   * to every connected peer
   */
  announce: SharePolicy
  /**
   * Whether a peer should have access to the document
   */
  access: (peer: PeerId, doc: DocumentId) => Promise<boolean>
}

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
      type: "doc-compacted"
      documentId: DocumentId
      durationMillis: number
    }
  | {
      type: "doc-saved"
      documentId: DocumentId
      durationMillis: number
      sinceHeads: Array<string>
    }
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

function hasCallbacks(
  s: SedimentreeStorage | undefined
): s is SubductionStorageWithCallbacks {
  return !!s && "on" in s && typeof s.on === "function"
}
