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
    toSedimentreeAutomerge,
    toSedimentreeId,
    toSubductionPeerId,
} from "./helpers/subduction.js"
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
    BinaryDocumentId,
    DocumentId,
    PeerId,
} from "./types.js"
import { abortable, AbortOptions, AbortError } from "./helpers/abortable.js"
import { FindProgress } from "./FindProgress.js"
import {
    BlobMeta,
    Digest,
    Fragment,
    FragmentRequested,
    FragmentStateStore,
    HashMetric,
    LooseCommit,
    Sedimentree,
    SedimentreeAutomerge,
    SedimentreeId,
    Subduction,
    SubductionWebSocket,
} from "@automerge/automerge_subduction"

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

const hashMetric = new HashMetric(null)

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
    #handlesBySedimentreeId: Map<string, DocHandle<any>> // NOTE until doc IDs are [u8; 32]s
    #fragmentStateStore: FragmentStateStore
    #recentlySeenHeads: HashRing
    #lastHeadsSent: Set<string> // TODO move to subduction.wasm

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
    }: RepoConfig = {}) {
        super()
        this.#remoteHeadsGossipingEnabled = enableRemoteHeadsGossiping
        this.#log = debug(`automerge-repo:repo`)

        this.#idFactory = idFactory || null
        // Handle legacy sharePolicy
        if (sharePolicy != null && shareConfig != null) {
            throw new Error(
                "cannot provide both sharePolicy and shareConfig at once"
            )
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
        this.synchronizer.on("metrics", event =>
            this.emit("doc-metrics", event)
        )

        if (this.#remoteHeadsGossipingEnabled) {
            this.synchronizer.on("open-doc", ({ peerId, documentId }) => {
                this.#remoteHeadsSubscriptions.subscribePeerToDoc(
                    peerId,
                    documentId
                )
            })
        }

        // STORAGE
        // The storage subsystem has access to some form of persistence, and deals with save and loading documents.
        const storageSubsystem = storage
            ? new StorageSubsystem(storage)
            : undefined
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
            this.#saveFn = ({
                handle,
                doc,
            }: DocHandleEncodedChangePayload<any>) => {
                let fn = this.#saveFns[handle.documentId]
                if (!fn) {
                    fn = throttle(
                        ({
                            doc,
                            handle,
                        }: DocHandleEncodedChangePayload<any>) => {
                            void this.storageSubsystem!.saveDoc(
                                handle.documentId,
                                doc
                            )
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
                    console.log("error in share policy", { err })
                })

            this.synchronizer.addPeer(peerId)
        })

        // When a peer disconnects, remove it from the synchronizer
        networkSubsystem.on("peer-disconnected", ({ peerId }) => {
            this.synchronizer.removePeer(peerId)
            this.#disconnectSubductionPeer(peerId)
            this.#remoteHeadsSubscriptions.removePeer(peerId)
        })

        // Handle incoming messages
        networkSubsystem.on("message", async msg => {
            this.#receiveMessage(msg)
        })

        this.synchronizer.on("sync-state", message => {
            this.#saveSyncState(message)

            const handle = this.#handleCache[message.documentId]

            const { storageId } =
                this.peerMetadataByPeerId[message.peerId] || {}
            if (!storageId) {
                return
            }

            const heads = handle.getSyncInfo(storageId)?.lastHeads
            const haveHeadsChanged =
                message.syncState.theirHeads &&
                (!heads ||
                    !headsAreSame(
                        heads,
                        encodeHeads(message.syncState.theirHeads)
                    ))

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
            this.#remoteHeadsSubscriptions.on(
                "notify-remote-heads",
                message => {
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
                }
            )

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

        if (!subduction) throw new Error("Subduction instance is required")
        this.#subduction = subduction
        this.#fragmentStateStore = new FragmentStateStore()
        this.#recentlySeenHeads = new HashRing(256)
        this.#lastHeadsSent = new Set<string>()
        this.#handlesBySedimentreeId = new Map()
        this.#setupSubductionSyncServer(peerId)
    }

    // The `document` event is fired by the DocCollection any time we create a new document or look
    // up a document by ID. We listen for it in order to wire up storage and network synchronization.
    #registerHandleWithSubsystems(handle: DocHandle<any>) {
        if (this.storageSubsystem) {
            // Add save function as a listener if it's not already registered
            const existingListeners = handle.listeners("heads-changed")
            if (
                !existingListeners.some(listener => listener === this.#saveFn)
            ) {
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
            handler = this.#throttledSaveSyncStateHandlers[storageId] =
                throttle(({ documentId, syncState }: SyncStatePayload) => {
                    void this.storageSubsystem!.saveSyncState(
                        documentId,
                        storageId,
                        syncState
                    )
                }, this.#saveDebounceRate)
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

        this.#registerHandleWithSubsystems(handle)

        handle.update(() => {
            return initialDoc
        })

        handle.doneLoading()
        toSedimentreeId(documentId).then(sid =>
            this.#subduction.requestAllBatchSync(sid)
        )
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
            const rawDocId = await this.#idFactory(
                Automerge.getHeads(initialDoc)
            )
            documentId = binaryToDocumentId(rawDocId as BinaryDocumentId)
        }
        const handle = this.#getHandle<T>({
            documentId,
        }) as DocHandle<T>

        this.#registerHandleWithSubsystems(handle)

        handle.update(() => {
            return initialDoc
        })

        handle.doneLoading()
        toSedimentreeId(documentId).then(sid =>
            this.#subduction.requestAllBatchSync(sid)
        )
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
                progressSignal.subscribers.forEach(callback =>
                    callback(progress)
                )
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
            signal
                ? abortable(new Promise(() => {}), signal)
                : new Promise(() => {})
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
        console.log("loadDocumentWithProgress", { id, documentId })
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
                await this.#requestDocOverSubduction(handle)
                // await Promise.race([
                //     this.networkSubsystem.whenReady(),
                //     abortPromise,
                // ])
                handle.request()
                progressSignal.notify({
                    state: "loading" as const,
                    progress: 75,
                    handle,
                })
            }

            this.#registerHandleWithSubsystems(handle)

            await Promise.race([
                handle.whenReady([READY, UNAVAILABLE]),
                abortPromise,
            ])

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
        const { allowableStates = ["ready"], signal } = options

        // Check if already aborted
        if (signal?.aborted) {
            throw new AbortError()
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
        if (!this.storageSubsystem) {
            return
        }
        const handles = documents
            ? documents.map(id => this.#handleCache[id])
            : Object.values(this.#handleCache)
        await Promise.all(
            handles.map(async handle => {
                return this.storageSubsystem!.saveDoc(
                    handle.documentId,
                    handle.doc()
                )
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
            delete this.#saveFns[documentId]
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

    shareConfigChanged() {
        void this.synchronizer.reevaluateDocumentShare()
    }

    #disconnectSubductionPeer(peerId: PeerId) {
        // TODO BZ
        //
        // const peerIdBytes = new TextEncoder().encode(peerId)
        // const out = new Uint8Array(32)
        // out.set(peerIdBytes.slice(0, 32))
        // const subPeerId = new Wasm.PeerId(out)
        // this.#subduction.disconnect(subPeerId)
    }

    async #setupSubductionSyncServer(peerId: PeerId) {
        const subPeerId = toSubductionPeerId(peerId)
        const ws = new WebSocket("//127.0.0.1:8080")

        ws.addEventListener("close", ev => {
            console.debug(
                "socket closed",
                ev.code, // close code (e.g. 1000, 1006…)
                ev.reason, // optional reason string
                ev.wasClean // whether a proper close frame was seen
            )
        })

        const wsAdapter = await SubductionWebSocket.setup(subPeerId, ws, 5000)
        await this.#subduction.attach(wsAdapter)
        console.debug("Subduction attached to WebSocket")

        // Incremental sync
        this.#subduction.onCommit(
            async (
                id: SedimentreeId,
                loose_commit: LooseCommit,
                blob: Uint8Array
            ) => {
                console.debug("subduction onCommit", {
                    id,
                    loose_commit,
                })
                const existingHandle = this.#handlesBySedimentreeId.get(
                    id.toString()
                )

                if (existingHandle !== undefined) {
                    console.debug("blob", blob)
                    existingHandle.update(doc =>
                        Automerge.loadIncremental(doc, blob)
                    )
                    existingHandle.doneLoading()
                } else {
                    console.warn("no handle for sedimentree id", { id })
                    // FIXME temporary hack  while docIDs are not [u8; 32]s
                    const initialDoc: Automerge.Doc<any> =
                        Automerge.emptyChange(Automerge.init())
                    let { documentId } = parseAutomergeUrl(
                        generateAutomergeUrl()
                    )
                    if (this.#idFactory) {
                        const rawDocId = await this.#idFactory(
                            Automerge.getHeads(initialDoc)
                        )
                        documentId = binaryToDocumentId(
                            rawDocId as BinaryDocumentId
                        )
                    }
                    const newHandle = this.#getHandle<any>({
                        documentId,
                    }) as DocHandle<any>

                    newHandle.update(() => initialDoc)
                    newHandle.update(doc =>
                        Automerge.loadIncremental(doc, blob)
                    )
                    this.#registerHandleWithSubsystems(newHandle)
                    newHandle.doneLoading()
                    console.log({ newHandle })
                }
            }
        )

        // Incremental sync
        this.#subduction.onFragment(
            (id: SedimentreeId, fragment: Fragment, blob: Uint8Array) => {
                console.debug("subduction onFragment", { id, fragment })
                const handle = this.#handlesBySedimentreeId.get(id.toString())
                if (handle !== undefined && handle !== null) {
                    console.debug("blob", blob)
                    handle.update(doc => Automerge.loadIncremental(doc, blob))
                    handle.doneLoading()
                } else {
                    // FIXME error ahndling if no such handle and/or create one?
                    console.warn("no handle for sedimentree id", {
                        id: id.toString(),
                    })
                }
            }
        )

        this.#subduction.onBlob((_blob: Uint8Array) => {
            console.log("subduction onBlob")
        })
    }

    async #requestDocOverSubduction(handle: DocHandle<any>) {
        const sedimentreeId = await toSedimentreeId(handle.documentId)
        this.#handlesBySedimentreeId.set(sedimentreeId.toString(), handle)
        const peerResultMap = await this.#subduction.requestAllBatchSync(
            sedimentreeId
        )
        console.log("subduction peerResultMap", {
            peerResultMap,
            entries: peerResultMap.entries(),
        })
        peerResultMap.entries().forEach(batchSyncResult => {
            if (!batchSyncResult.success) {
                console.warn("failed PeerBatchSyncResult")
            }

            for (const err in batchSyncResult.connErrors) {
                console.error("PeerBatchSyncResult connError: ", err)
            }

            console.info("blobs len", batchSyncResult.blobs.length)
            batchSyncResult.blobs.forEach(bundleBlob => {
                console.log("progress bundleBlob", bundleBlob)
                handle.update(doc => Automerge.loadIncremental(doc, bundleBlob))
                handle.doneLoading()
            })
        })
    }

    async #tellSubductionAboutNewHandle(handle: DocHandle<any>) {
        console.debug("telling subduction about new handle", { handle })
        const sid = await toSedimentreeId(handle.documentId)
        this.#handlesBySedimentreeId.set(sid.toString(), handle)
        this.#subduction.addSedimentree(sid, Sedimentree.empty())
        console.debug("added sedimentree to subduction", {
            documentId: handle.documentId,
        })

        handle.on("heads-changed", ({ doc }) => {
            console.warn("heads-changed event fired")
            const currentHexHeads = Automerge.getHeads(doc)
            if (new Set(currentHexHeads) == this.#lastHeadsSent) {
                console.debug("nothing new to send, skipping sync...")
                return
            } else {
                console.debug("new data to sync, proceeding...")
            }

            Automerge.getChangesMetaSince(
                doc,
                Array.from(this.#lastHeadsSent)
            ).forEach(meta => {
                const hexHash = meta.hash
                if (!this.#recentlySeenHeads.add(hexHash)) {
                    console.debug(
                        `already recently seen ${hexHash}, skipping sync...`
                    )
                }
                // HACK: the horror!  👹
                const sym = Object.getOwnPropertySymbols(doc).find(
                    s => s.description === "_am_meta"
                )!
                const innerDoc = (doc as any)[sym].handle
                const commitBytes = innerDoc.getChangeByHash(hexHash)

                const binHash = new Uint8Array(hexHash.length / 2)
                for (let i = 0; i < 32; i++) {
                    binHash[i] = parseInt(hexHash.slice(i * 2, i * 2 + 2), 16)
                }
                const digest = new Digest(binHash)
                const parents = meta.deps.map(depHexHash => {
                    const bin = new Uint8Array(depHexHash.length / 2)
                    for (let i = 0; i < 32; i++) {
                        bin[i] = parseInt(
                            depHexHash.slice(i * 2, i * 2 + 2),
                            16
                        )
                    }
                    return new Digest(bin)
                })
                const blobMeta = new BlobMeta(commitBytes)
                const looseCommit = new LooseCommit(digest, parents, blobMeta)

                this.#subduction
                    .addCommit(sid, looseCommit, commitBytes)
                    .then(maybeFragmentRequested => {
                        if (
                            maybeFragmentRequested !== null &&
                            maybeFragmentRequested !== undefined
                        ) {
                            const fragmentRequested: FragmentRequested =
                                maybeFragmentRequested
                            console.debug("commit needs fragment, creating...")

                            const sam = toSedimentreeAutomerge(doc)
                            const fragmentState = sam.fragment(
                                fragmentRequested.head,
                                this.#fragmentStateStore,
                                hashMetric
                            )
                            const members = fragmentState
                                .members()
                                .map(digest => {
                                    return Array.from(digest.toBytes(), b =>
                                        b.toString(16).padStart(2, "0")
                                    ).join("")
                                })
                            // NOTE this is the only(?) function that we need from AM v3.2.0
                            const fragmentBlob = Automerge.saveBundle(
                                doc,
                                members
                            )
                            const blobMeta = new BlobMeta(fragmentBlob)
                            const fragment =
                                fragmentState.intoFragment(blobMeta)

                            this.#subduction
                                .addFragment(sid, fragment, fragmentBlob)
                                .catch(console.error)
                        }
                    })

                this.#lastHeadsSent = new Set(currentHexHeads)
            })
        })
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
     * The subduction sync engine
     */
    subduction?: Subduction
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
