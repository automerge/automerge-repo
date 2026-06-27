import { next as Automerge, Heads } from "@automerge/automerge/slim"
import { makeLogger } from "./Logger.js"
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
import {
  DocumentQuery,
  progressAtHeads,
  progressAtPath,
  type DocumentProgress,
} from "./DocumentQuery.js"
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
} from "./types.js"
import { AbortOptions, AbortError } from "./helpers/abortable.js"
export type { FindProgressWithMethods, ProgressSignal } from "./_compat.js"
import { Document } from "./Document.js"
import { truePromiseFactory } from "./helpers/truePromiseFactory.js"
import { isPlainObject } from "./helpers/isPlainObject.js"
import { hasAtLeastOneKey } from "./helpers/has-at-least-one-key.js"
import { noop } from "./helpers/noop.js"
import { semaphore } from "./helpers/semaphore.js"

/**
 * Default for {@link RepoConfig.flushConcurrency}: the number of documents
 * {@link Repo.flush} writes to storage concurrently. A sync server may hold
 * thousands of documents; flushing them all at once would spike the storage
 * adapter's connections / file descriptors / memory, so the fan-out is bounded.
 */
const DEFAULT_FLUSH_CONCURRENCY = 20

export type { DocumentProgress } from "./DocumentQuery.js"
export { DocumentQuery } from "./DocumentQuery.js"

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
  #log = makeLogger("automerge-repo:repo")

  /** @hidden */
  networkSubsystem: NetworkSubsystem
  /** @hidden */
  storageSubsystem?: StorageSubsystem

  #queries: Record<DocumentId, DocumentQuery<any>> = {}

  /** @hidden */
  synchronizer: CollectionSynchronizer

  #sources = new Map<string, DocumentSource>()

  #shareConfig: ShareConfig = {
    announce: truePromiseFactory,
    access: truePromiseFactory,
  }

  /** maps peer id to to persistence information (storageId, isEphemeral), access by collection synchronizer  */
  /** @hidden */
  peerMetadataByPeerId: Record<PeerId, PeerMetadata> = {}

  #syncStateTracker: SyncStateTracker
  #remoteHeadsSubscriptions = new RemoteHeadsSubscriptions()
  #remoteHeadsGossipingEnabled = false
  #idFactory: ((initialHeads: Heads) => Promise<Uint8Array>) | null
  #flushConcurrency: number

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
    flushConcurrency = DEFAULT_FLUSH_CONCURRENCY,
    idFactory,
  }: RepoConfig = {}) {
    super()
    this.#remoteHeadsGossipingEnabled = enableRemoteHeadsGossiping
    this.#flushConcurrency = flushConcurrency

    this.#idFactory = idFactory || null
    // Handle legacy sharePolicy
    if (sharePolicy != null && shareConfig != null) {
      throw new Error("cannot provide both sharePolicy and shareConfig at once")
    }
    if (sharePolicy) {
      this.#shareConfig = {
        announce: sharePolicy,
        access: truePromiseFactory,
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

    this.storageSubsystem = storageSubsystem
    this.#syncStateTracker = new SyncStateTracker(
      this.storageSubsystem,
      saveDebounceRate
    )

    if (storageSubsystem) {
      this.#sources.set(
        "storage",
        new StorageSource(storageSubsystem, saveDebounceRate)
      )
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
        priority: 0,
        ensureQuery: id => this.#ensureQuery(id),
        loadSyncState: async (documentId, pid) => {
          if (!this.storageSubsystem) return
          const { storageId, isEphemeral: isEph } =
            this.peerMetadataByPeerId[pid] || {}
          if (!storageId || isEph) return
          return this.storageSubsystem.loadSyncState(documentId, storageId)
        },
        // Resolve to void once the adapters are ready, or on adapter failure
        // (logged): networkReady gates "peers have had their chance to connect",
        // so a failed network should let documents settle rather than hang, and
        // it must never reject (no consumer acts on the rejection, and an
        // unhandled one would surface before any DocSynchronizer attaches).
        networkReady: networkSubsystem
          .whenReady()
          .then(noop, err =>
            this.#log.error("network adapters failed to become ready", err)
          ),
      },
      denylist
    )
    this.#sources.set("automerge-sync", this.synchronizer)

    // When the synchronizer emits messages, send them to peers
    this.synchronizer.on("message", message => {
      this.#log.debug(`sending ${message.type} message to ${message.targetId}`)
      networkSubsystem.send(message)
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
      this.#log.debug("peer connected", { peerId })

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
          this.#log.error("error in share policy", { err })
        })

      this.synchronizer.addPeer(peerId)
    })

    // When a peer disconnects, remove it from the synchronizer
    networkSubsystem.on("peer-disconnected", ({ peerId }) => {
      this.synchronizer.removePeer(peerId)
      this.#remoteHeadsSubscriptions.removePeer(peerId)
    })

    // Inbound messages are untrusted peer input, so #receiveMessage can throw on
    // a malformed or cross-version message. An EventEmitter does not trap a
    // listener's exception, so an uncaught throw here aborts the emit() dispatch
    // (other listeners skipped) and unwinds back through the transport's
    // event-loop callback that delivered the message. In Node an uncaught error
    // there terminates the process by default, so one bad message could take
    // down a sync server; in a browser it is only logged. Catch it.
    // See https://nodejs.org/api/process.html#event-uncaughtexception
    networkSubsystem.on("message", msg => {
      try {
        this.#receiveMessage(msg)
      } catch (err) {
        this.#log.error("error handling inbound message", err)
      }
    })

    this.synchronizer.on("sync-state", message => {
      const handle = this.#queries[message.documentId]?.handle
      if (!handle) return

      const peerMeta = this.peerMetadataByPeerId[message.peerId]
      const change = this.#syncStateTracker.handleSyncState(
        message,
        peerMeta,
        handle
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
        this.#log.debug("change-remote-subs", message)
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
   * and the CollectionSynchronizer's ensureQuery callback (inbound).
   *
   * If `initialDoc` is provided (create/import path), storage loading is
   * skipped and the doc is applied after registration so that the storage
   * listener captures the initial data.
   */
  #ensureQuery(
    documentId: DocumentId,
    initialDoc?: Automerge.Doc<unknown>
  ): DocumentQuery<unknown> {
    const existing = this.#queries[documentId]
    if (existing) {
      return existing
    }

    const document = new Document(
      documentId,
      initialDoc ?? Automerge.init(),
      storageId => this.#syncStateTracker.getSyncInfo(documentId, storageId)
    )
    const handle = new DocHandle(document, {})
    const query = new DocumentQuery(handle, this.#sources)
    this.#queries[documentId] = query

    // Attach all sources. Each source calls sourcePending/sourceUnavailable
    // as appropriate and sets up its own listeners. When initialDoc is
    // provided the handle already has data, so sources see a ready handle
    // from the start.
    for (const source of this.#sources.values()) {
      source.attach(query)
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

    // If the initial value is an empty object, use the empty change initialisation path instead of the from path
    if (isPlainObject(initialValue) && hasAtLeastOneKey(initialValue)) {
      initialDoc = Automerge.from(initialValue)
    } else {
      initialDoc = Automerge.emptyChange(Automerge.init())
    }

    const { documentId } = parseAutomergeUrl(generateAutomergeUrl())
    const query = this.#ensureQuery(
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
    const query = this.#ensureQuery(
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
    const sourceDoc = clonedHandle.fullDoc()
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
  findWithProgress<T>(
    id: AnyDocumentId,
    // the original automerge-repo v2 accepted `AbortOptions` here which could
    // be passed an abort signal. For now we accept the signal to remain backwards
    // compatible but ignore it. The main feature we miss vs the original API is the
    // ability to not create a doc handle if we abort while loading. Once the DocHandle
    // was running the abort signal didn't have much effect
    _options?: AbortOptions
  ): DocumentProgress<T> {
    const parsed = isValidAutomergeUrl(id)
      ? parseAutomergeUrl(id)
      : {
          documentId: interpretAsDocumentId(id),
          heads: undefined,
          segments: undefined,
        }
    const { documentId, heads, segments } = parsed

    // ensureQuery creates the query, handle, sets up all sources, and
    // registers with the sync layer (no-ops if already added).
    if (!this.#queries[documentId]) {
      this.#ensureQuery(documentId)
    }
    const query = this.#queries[documentId] as DocumentQuery<T>

    // A URL can carry both fixed heads (`#h1|h2`) and a path suffix
    // (`/a/@0/b`). Layer the heads projection first (it gates readiness on
    // those heads being present), then scope to the path. The two compose
    // to the same canonical handle regardless of order.
    let progress: DocumentProgress<T> = query
    if (heads) progress = progressAtHeads(query, heads)
    if (segments && segments.length > 0) {
      progress = progressAtPath(progress, segments)
    }
    return progress
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

    // `findWithProgress` already applies any path suffix (`/a/@0/b`) and
    // fixed heads (`#h1|h2`) from the URL, so the ready handle is correctly
    // scoped and/or view-pinned.
    return this.findWithProgress<T>(id).whenReady({ signal })
  }

  /**
   * @deprecated Alias for {@link Repo.find}. Will be removed in the next major release
   */
  findClassic<T>(
    id: AnyDocumentId,
    options: RepoFindOptions & AbortOptions = {}
  ): Promise<DocHandle<T>> {
    return this.find<T>(id, options)
  }

  delete(id: AnyDocumentId) {
    const documentId = interpretAsDocumentId(id)

    const query = this.#queries[documentId]
    if (query?.handle) {
      // Fans out to all retained handles (root + subs) via the registry
      // and flips the document's `deleted` flag.
      query.handle.delete()
    }
    if (query) {
      query.fail(new Error(`Document ${documentId} was deleted`))
    }
    delete this.#queries[documentId]

    for (const source of this.#sources.values()) {
      source.detach(documentId)
    }
    this.#syncStateTracker.delete(documentId)

    if (this.storageSubsystem) {
      this.storageSubsystem.removeDoc(documentId).catch(err => {
        this.#log.error("error deleting document from storage", {
          documentId,
          err,
        })
      })
    }

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
    const handle = await this.find(id)
    return Automerge.save(handle.fullDoc())
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
      const query = this.#ensureQuery(
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
      this.#log.debug("subscribeToRemotes", { remotes })
      this.#remoteHeadsSubscriptions.subscribeToRemotes(remotes)
    } else {
      this.#log.warn(
        "subscribeToRemotes called but remote heads gossiping is not enabled"
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
   *
   * @remarks
   * Two coordination guarantees, both aimed at flushing a large collection
   * safely (a sync server may hold thousands of documents):
   *
   * - **Bounded fan-out.** At most {@link RepoConfig.flushConcurrency} document
   *   saves run at once, instead of launching every save simultaneously.
   * - **Drain before settle.** Every save is awaited (`allSettled`) before
   *   `flush()` settles, even if some fail; this is what makes `flush()` safe to
   *   `await` before teardown in {@link Repo.shutdown} (nothing is still writing
   *   when the caller proceeds). Failures are collected and rethrown as an
   *   `AggregateError`.
   */
  async flush(documents?: DocumentId[]): Promise<void> {
    if (!this.storageSubsystem) {
      return
    }

    const ids = documents ?? (Object.keys(this.#queries) as DocumentId[])
    // Bound the fan-out so flushing a large collection doesn't open every
    // storage write at once. State is re-read inside the limited task because a
    // query may have changed between enqueue and execution.
    const limit = semaphore(this.#flushConcurrency)
    const results = await Promise.allSettled(
      ids.map(id =>
        limit(async () => {
          const state = this.#queries[id]?.peek()
          if (state?.state === "ready") {
            await this.storageSubsystem!.saveDoc(id, state.handle.fullDoc())
          }
        })
      )
    )

    // Surface failures, but only after every save has settled so teardown
    // (shutdown) never runs while a save is still in flight.
    const failures = results
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map(r => r.reason)
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `flush: ${failures.length} of ${ids.length} document save(s) failed`
      )
    }
  }

  /**
   * Removes a DocHandle from the handleCache.
   * @hidden this API is experimental and may change.
   * @param documentId - documentId of the DocHandle to remove from handleCache, if present in cache.
   */
  async removeFromCache(documentId: DocumentId): Promise<void> {
    for (const source of this.#sources.values()) {
      source.detach(documentId)
    }
    delete this.#queries[documentId]
    this.#syncStateTracker.delete(documentId)
  }

  async shutdown(): Promise<void> {
    // Drain saves first (flush awaits all of them), then always disconnect in
    // the finally so a partial flush failure (which rejects flush) still tears
    // down the network rather than leaking connections.
    try {
      await this.flush()
    } finally {
      this.networkSubsystem.disconnect()
    }
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

  /**
   * Maximum number of documents {@link Repo.flush} (and {@link Repo.shutdown})
   * write to storage concurrently. Defaults to 20.
   *
   * @remarks
   * Tie this to the constraining resource of your
   * {@link StorageAdapterInterface}:
   * - **filesystem** (e.g. the nodefs adapter): stay well under the process's
   *   file-descriptor ceiling; the default 20 is comfortable.
   * - **HTTP/1.1-backed**: a browser caps connections per origin at ~6, so a
   *   limit near that avoids head-of-line queueing you can't see.
   * - **HTTP/2-backed**: ~100 multiplexed streams per connection, so you can go
   *   higher.
   * - **database-backed**: at or below the connection-pool size, leaving
   *   headroom for other callers.
   */
  flushConcurrency?: number

  // This is hidden for now because it's an experimental API, mostly here in order
  // for keyhive to be able to control the ID generation
  /**
   * @hidden
   */
  idFactory?: (initialHeads: Heads) => Promise<Uint8Array>
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

export type RepoFindOptions = {
  /**
   * @deprecated This no longer has any effect, instead you should use
   * {@link Repo.findWithProgress} to get progress information.
   */
  allowableStates?: string[]
}

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
}
