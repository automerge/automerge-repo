import { next as Automerge, Heads } from "@automerge/automerge/slim"
import debug from "debug"
import { EventEmitter } from "eventemitter3"
import {
  binaryToDocumentId,
  generateAutomergeUrl,
  interpretAsDocumentId,
  isValidAutomergeUrl,
  parseAutomergeUrl,
} from "./AutomergeUrl.js"
import { DocHandle } from "./DocHandle.js"
import type { DocumentSource } from "./DocumentSource.js"
import { DocumentQuery, type DocumentProgress } from "./DocumentQuery.js"
import { RemoteHeadsSubscriptions } from "./RemoteHeadsSubscriptions.js"
import { StorageSource } from "./StorageSource.js"
import { SyncStateTracker } from "./SyncStateTracker.js"
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
import type {
  AnyDocumentId,
  AutomergeUrl,
  BinaryDocumentId,
  DocumentId,
  PeerId,
  SessionId,
} from "./types.js"
import { AbortOptions, AbortError } from "./helpers/abortable.js"
import {
  MemorySigner,
  set_subduction_logger,
} from "@automerge/automerge-subduction/slim"
import { SubductionStorageBridge } from "./subduction/storage.js"
import { SubductionSource } from "./subduction/source.js"
import type { Policy as SubductionPolicy } from "@automerge/automerge-subduction/slim"
import { DummyStorageAdapter } from "./helpers/DummyStorageAdapter.js"
import { encode, decode } from "cbor-x"
import type { EphemeralMessage } from "./network/messages.js"

export type { DocumentProgress, QueryState } from "./DocumentQuery.js"
export { DocumentQuery } from "./DocumentQuery.js"

let subductionLoggingEnabled = false

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

  #queries: Record<DocumentId, DocumentQuery<any>> = {}

  /** @hidden */
  synchronizer: CollectionSynchronizer

  #sources: DocumentSource[] = []

  #shareConfig: ShareConfig = {
    announce: async () => true,
    access: async () => true,
  }

  /** maps peer id to to persistence information (storageId, isEphemeral), access by collection synchronizer  */
  /** @hidden */
  peerMetadataByPeerId: Record<PeerId, PeerMetadata> = {}

  #syncStateTracker = new SyncStateTracker()
  #remoteHeadsSubscriptions = new RemoteHeadsSubscriptions()
  #remoteHeadsGossipingEnabled = false
  #subductionSource: SubductionSource | null = null
  #idFactory: ((initialHeads: Heads) => Promise<Uint8Array>) | null
  #peerId: PeerId

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
    signer,
    subductionPolicy,
    subductionWebsocketEndpoints,
    subductionAdapters,
    periodicSyncInterval,
    batchSyncInterval,
  }: RepoConfig = {}) {
    super()
    this.#peerId = peerId
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

    // STORAGE
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

    if (!subductionLoggingEnabled) {
      subductionLoggingEnabled = true
      set_subduction_logger(
        (level: string, target: string, message: string, fields: any) => {
          // Create a debug logger for this Rust module
          const log = debug(`automerge-repo:subduction:${target}`)

          // Format the message with fields if present
          const hasFields = fields && Object.keys(fields).length > 0
          const formattedMessage = hasFields
            ? `${message} ${JSON.stringify(fields)}`
            : message

          // Log at the appropriate level (debug supports arbitrary namespaces, not levels,
          // so we prefix with the level for visibility)
          log(`[${level}] ${formattedMessage}`)
        }
      )
    }
    let subductionStorage: SubductionStorageBridge
    if (storage) {
      subductionStorage = new SubductionStorageBridge(storage)
    } else {
      subductionStorage = new SubductionStorageBridge(new DummyStorageAdapter())
    }
    const subductionSource = new SubductionSource({
      peerId,
      storage: subductionStorage,
      signer: signer ?? new MemorySigner(),
      websocketEndpoints: subductionWebsocketEndpoints ?? [],
      adapters: subductionAdapters ?? [],
      policy: subductionPolicy,
      onRemoteHeadsChanged: enableRemoteHeadsGossiping
        ? (documentId, storageId, heads) => {
            this.#remoteHeadsSubscriptions.handleImmediateRemoteHeadsChanged(
              documentId,
              storageId,
              heads
            )
          }
        : undefined,
      onEphemeral: (sedimentreeId, _senderId, payload) => {
        try {
          const msg = decode(new Uint8Array(payload)) as EphemeralMessage
          this.synchronizer.receiveMessage(msg)
        } catch (e) {
          this.#log("failed to decode inbound subduction ephemeral: %O", e)
        }
      },
      onHealExhausted: documentId => {
        this.emit("heal-exhausted", { documentId })
      },
      periodicSyncInterval,
      batchSyncInterval,
    })
    this.#subductionSource = subductionSource
    this.#sources.push(subductionSource)

    this.storageSubsystem = storageSubsystem

    // STORAGE SOURCE
    if (storageSubsystem) {
      this.#sources.push(new StorageSource(storageSubsystem, saveDebounceRate))
    }

    // NETWORK
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

    // COLLECTION SYNCHRONIZER
    this.synchronizer = new CollectionSynchronizer(
      {
        peerId,
        shareConfig: this.#shareConfig,
        ensureHandle: id => this.#ensureHandle(id),
        loadSyncState: async (documentId, pid) => {
          if (!this.storageSubsystem) return
          const { storageId, isEphemeral: isEph } =
            this.peerMetadataByPeerId[pid] || {}
          if (!storageId || isEph) return
          return this.storageSubsystem.loadSyncState(documentId, storageId)
        },
        networkReady: networkSubsystem.whenReady().then(() => {}),
      },
      denylist
    )
    this.#sources.push(this.synchronizer)

    // When the synchronizer emits messages, send them to peers
    this.synchronizer.on("message", message => {
      this.#log(`sending ${message.type} message to ${message.targetId}`)
      networkSubsystem.send(message)
    })

    // Tunnel inbound ephemeral messages from network adapters through
    // subduction, so they reach peers connected via websocket transport.
    networkSubsystem.on("message", message => {
      if (message.type === "ephemeral" && this.#subductionSource) {
        const payload = new Uint8Array(encode(message))
        this.#subductionSource.publishEphemeral(message.documentId, payload)
      }
    })

    // Forward sync metrics events
    this.synchronizer.on("metrics", event => this.emit("doc-metrics", event))

    // Track which peers have which documents open (for remote heads gossiping)
    this.synchronizer.on("open-doc", ({ peerId, documentId }) => {
      if (this.#remoteHeadsGossipingEnabled) {
        this.#remoteHeadsSubscriptions.subscribePeerToDoc(peerId, documentId)
      }
    })

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
      this.#remoteHeadsSubscriptions.removePeer(peerId)
    })

    // Handle incoming messages
    networkSubsystem.on("message", async msg => {
      this.#receiveMessage(msg)
    })

    this.synchronizer.on("sync-state", message => {
      const handle = this.#queries[message.documentId]?.handle
      if (!handle) return

      const peerMeta = this.peerMetadataByPeerId[message.peerId]
      const change = this.#syncStateTracker.handleSyncState(
        message,
        peerMeta,
        handle,
        this.storageSubsystem
      )

      if (change && this.#remoteHeadsGossipingEnabled) {
        this.#remoteHeadsSubscriptions.handleImmediateRemoteHeadsChanged(
          message.documentId,
          change.storageId,
          change.heads
        )
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
          const handle = this.#queries[documentId]?.handle
          if (!handle) return
          this.#syncStateTracker.handleRemoteHeadsChanged(
            documentId,
            storageId,
            remoteHeads,
            timestamp,
            handle
          )
        }
      )
    }
  }

  /**
   * Create a query, handle, set up all sources, and register with the sync
   * layer. Safe to call multiple times — attach no-ops if the document
   * is already registered. Used by findWithProgress (outbound), create/import,
   * and the CollectionSynchronizer's ensureHandle callback (inbound).
   *
   * If `initialDoc` is provided (create/import path), storage loading is
   * skipped and the doc is applied after registration so that the storage
   * listener captures the initial data.
   */
  #ensureHandle(
    documentId: DocumentId,
    initialDoc?: Automerge.Doc<unknown>
  ): DocumentQuery<unknown> {
    const existing = this.#queries[documentId]
    if (existing) {
      return existing
    }

    const query = new DocumentQuery(documentId, initialDoc)
    this.#queries[documentId] = query

    // Attach all sources. Each source calls sourcePending/sourceUnavailable
    // as appropriate and sets up its own listeners. When initialDoc is
    // provided the handle already has data, so sources see a ready handle
    // from the start.
    for (const source of this.#sources) {
      source.attach(query)
    }

    // Bridge outbound ephemeral messages to Subduction.
    // This fires once per DocHandle.broadcast() call, independent of
    // whether there are any old-protocol sync peers.
    if (this.#subductionSource) {
      const subductionSource = this.#subductionSource
      query.handle.on("ephemeral-message-outbound", ({ data }) => {
        console.log(
          `[repo] ephemeral outbound for ${documentId.slice(0, 8)}, ${
            data.byteLength
          } bytes`
        )
        const fullMsg: EphemeralMessage = {
          type: "ephemeral",
          senderId: this.#peerId,
          targetId: this.#peerId, // not meaningful for pub/sub
          documentId,
          data,
          count: 0,
          sessionId: "subduction-bridge" as SessionId,
        }
        const payload = new Uint8Array(encode(fullMsg))
        subductionSource.publishEphemeral(documentId, payload)
      })
    }

    return query
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
        this.synchronizer.receiveMessage(message)
        break
    }
  }

  /** Returns all the handles we have cached. */
  get handles(): Record<DocumentId, DocHandle<any>> {
    const result: Record<DocumentId, DocHandle<any>> = {}
    for (const [id, query] of Object.entries(this.#queries)) {
      if (query.handle) {
        result[id as DocumentId] = query.handle
      }
    }
    return result
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

    const { documentId } = parseAutomergeUrl(generateAutomergeUrl())
    const query = this.#ensureHandle(
      documentId,
      initialDoc as Automerge.Doc<unknown>
    )
    return query.handle as DocHandle<T>
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
    const query = this.#ensureHandle(
      documentId,
      initialDoc as Automerge.Doc<unknown>
    )
    return query.handle as DocHandle<T>
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
    const sourceDoc = clonedHandle.doc()
    const handle = this.create<T>()
    handle.update(() => Automerge.clone(sourceDoc))
    return handle
  }

  /**
   * Returns a `DocumentProgress` for the given document. This is a reactive,
   * read-only view that tracks the ongoing state of the document.
   *
   * Use `subscribe` to observe state changes and `peek` to read the current
   * state. The `handle` is only available when the state is `"ready"`.
   */
  findWithProgress<T>(id: AnyDocumentId): DocumentProgress<T> {
    const { documentId } = isValidAutomergeUrl(id)
      ? parseAutomergeUrl(id)
      : { documentId: interpretAsDocumentId(id) }

    // If we already have a query for this document, return it
    if (this.#queries[documentId]) {
      return this.#queries[documentId] as DocumentProgress<T>
    }

    // ensureHandle creates the query, handle, sets up all sources, and
    // registers with the sync layer (attach no-ops if already added).
    this.#ensureHandle(documentId)

    return this.#queries[documentId] as DocumentProgress<T>
  }

  /**
   * Look up a document by URL and wait for it to be ready.
   */
  async find<T>(
    id: AnyDocumentId,
    options: RepoFindOptions & AbortOptions = {}
  ): Promise<DocHandle<T>> {
    const { signal } = options

    if (signal?.aborted) {
      throw new AbortError()
    }

    const { heads } = isValidAutomergeUrl(id)
      ? parseAutomergeUrl(id)
      : { heads: undefined }

    const progress = this.findWithProgress<T>(id)
    const handle = await progress.whenReady({ signal })
    return heads ? handle.view(heads) : handle
  }

  delete(id: AnyDocumentId) {
    const documentId = interpretAsDocumentId(id)

    const query = this.#queries[documentId]
    if (query?.handle) {
      query.handle.emit("delete", { handle: query.handle })
    }
    if (query) {
      query.fail(new Error(`Document ${documentId} was deleted`))
    }
    delete this.#queries[documentId]

    for (const source of this.#sources) {
      source.detach(documentId)
    }
    this.#syncStateTracker.delete(documentId)
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
    const handle = this.#queries[documentId]?.handle
    if (!handle) return undefined
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
      // Check if we already have a handle for this document
      const existing = this.#queries[docId]?.handle as DocHandle<T> | null
      if (existing) {
        existing.update(doc => Automerge.loadIncremental(doc, binary))
        return existing
      }
      const initialDoc = Automerge.load<T>(binary)
      const query = this.#ensureHandle(
        docId,
        initialDoc as Automerge.Doc<unknown>
      )
      return query.handle as DocHandle<T>
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

    const ids = documents ?? (Object.keys(this.#queries) as DocumentId[])
    await Promise.all(
      ids.map(async id => {
        const state = this.#queries[id]?.peek()
        if (state?.state === "ready") {
          await this.storageSubsystem!.saveDoc(id, state.handle.doc())
        }
      })
    )
  }

  /**
   * Removes a DocHandle from the handleCache.
   * @hidden this API is experimental and may change.
   * @param documentId - documentId of the DocHandle to remove from handleCache, if present in cache.
   */
  removeFromCache(documentId: DocumentId) {
    for (const source of this.#sources) {
      source.detach(documentId)
    }
    delete this.#queries[documentId]
    this.#syncStateTracker.delete(documentId)
  }

  async shutdown() {
    // Quiesce Subduction first — stops reconnect loops, flushes pending
    // saves, awaits storage writes, disconnects transports, frees Wasm
    await this.#subductionSource?.shutdown()

    // Stop traditional sync network connections
    this.networkSubsystem.disconnect()

    // Flush final Automerge document state to storage
    await this.flush()
  }

  metrics(): { documents: { [key: string]: any } } {
    return { documents: this.synchronizer.metrics() }
  }

  shareConfigChanged() {
    this.synchronizer.reevaluateDocumentShare()
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
   * Signer used for Subduction commit signatures and peer identity.
   * Defaults to a fresh `MemorySigner` (ephemeral key, lost on restart).
   * Pass a `WebCryptoSigner` (via `await WebCryptoSigner.setup()`) for
   * persistent identity across page loads.
   */
  signer?: unknown

  /** Authorization policy for the Subduction sync engine. See {@link Policy} from `@automerge/automerge-subduction`. */
  subductionPolicy?: SubductionPolicy

  subductionWebsocketEndpoints?: string[]

  subductionAdapters?: {
    adapter: NetworkAdapterInterface
    serviceName: string
    /** Whether to initiate ("connect") or accept ("accept") the subduction
     *  handshake for peers on this adapter. Defaults to "connect". */
    role?: "connect" | "accept"
  }[]

  /**
   * Interval in ms for per-document periodic sync via Subduction. Each open
   * document is synced individually (skipping those in heal-backoff).
   * Set to 0 to disable. Default: 10_000 (10s).
   */
  periodicSyncInterval?: number

  /**
   * Interval in ms for a full batch sync across all open documents via
   * Subduction. On success, all heal state is reset.
   * Set to 0 to disable. Default: 300_000 (5 min).
   */
  batchSyncInterval?: number
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
  access: (peerId: PeerId, documentId?: DocumentId) => Promise<boolean>
}

export type RepoFindOptions = {}

// Re-exported from DocHandle
export type { SyncInfo } from "./DocHandle.js"

export type DeleteDocumentPayload = { documentId: DocumentId }
export type DocumentPayload = { handle: DocHandle<any> }
export type DocMetrics = {
  type: string
  documentId: DocumentId
  [key: string]: unknown
}

// events & payloads
export interface RepoEvents {
  /** A new document was created or discovered */
  document: (payload: DocumentPayload) => void
  /** A document was deleted */
  "delete-document": (payload: DeleteDocumentPayload) => void
  /** A document was marked as unavailable (we don't have it and none of our peers have it) */
  "unavailable-document": (payload: DeleteDocumentPayload) => void
  "doc-metrics": (payload: DocMetrics) => void
  /** Self-healing sync gave up after all retry attempts for a document */
  "heal-exhausted": (payload: { documentId: DocumentId }) => void
}
