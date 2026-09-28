import { next as A } from "@automerge/automerge/slim"
import { makeLogger } from "../Logger.js"
import { EventEmitter } from "eventemitter3"
import { DocHandle } from "../DocHandle.js"
import { parseAutomergeUrl } from "../AutomergeUrl.js"
import {
  DocMessage,
  EphemeralStamp,
  MessageContents,
  OpenDocMessage,
} from "../network/messages.js"
import { AutomergeUrl, DocumentId, PeerId } from "../types.js"
import { DocSynchronizer, SHARE_POLICY_CONCURRENCY } from "./DocSynchronizer.js"
import type { ShareConfig } from "./DocSynchronizer.js"
import { semaphore, type Limit } from "../helpers/semaphore.js"
import { WeakValueMap } from "../helpers/WeakValueMap.js"
import type { DocumentSource } from "../DocumentSource.js"
import type { DocumentQuery, SourcePriority } from "../DocumentQuery.js"
import type { SyncStatePayload, DocSyncMetrics } from "./Synchronizer.js"

/**
 * Default cap on concurrent `loadSyncState` reads. Adding a peer loads sync
 * state once per document, and the collection adds every peer to every document
 * (`addPeer` loops all docs, `attach` loops all peers), so on a many-document
 * sync server an unbounded fan-out would issue that many storage reads at once.
 */
export const DEFAULT_SYNC_STATE_LOAD_CONCURRENCY = 20

/**
 * Default for {@link AutomergeSyncConfig.maxPinnedRequestsPerPeer}. A pinned
 * document this repo does not yet have costs an estimated 16 KB, so the worst
 * case is about 16 MB per peer.
 */
export const DEFAULT_MAX_PINNED_REQUESTS_PER_PEER = 1000

export interface AutomergeSyncConfig {
  peerId: PeerId

  shareConfig: ShareConfig

  /** Availability tier this source occupies. See {@link SourcePriority}. */
  priority: SourcePriority

  /**
   * Called when the sync layer receives a message for a document it doesn't
   * have a DocSynchronizer for. The Repo creates the query/handle, calls
   * attach, and returns the handle and query.
   */
  ensureQuery: (documentId: DocumentId) => DocumentQuery<unknown>

  /**
   * Load persisted sync state for a peer on a specific document. Returns
   * undefined if no sync state is available. Calls are bounded by
   * {@link AutomergeSyncConfig.syncStateLoadConcurrency}.
   */
  loadSyncState?: (
    documentId: DocumentId,
    peerId: PeerId
  ) => Promise<A.SyncState | undefined>

  /**
   * Maximum number of {@link AutomergeSyncConfig.loadSyncState} reads run
   * concurrently while adding peers to documents. Defaults to
   * {@link DEFAULT_SYNC_STATE_LOAD_CONCURRENCY}.
   */
  syncStateLoadConcurrency?: number

  /**
   * Resolves when the network layer is ready to send messages.
   * Documents created before this resolves get a "network" source
   * registered on their query to keep them in "loading" state until
   * peers have had a chance to connect.
   */
  networkReady: Promise<void>

  /**
   * Maximum number of share-policy resolutions run concurrently during
   * {@link CollectionSynchronizer.reevaluateDocumentShare}. Defaults to
   * {@link SHARE_POLICY_CONCURRENCY}.
   */
  sharePolicyConcurrency?: number

  /**
   * Allocates one {@link EphemeralStamp} per outbound broadcast.
   */
  stampEphemeralMessage: () => EphemeralStamp

  /**
   * Maximum number of documents one peer's unanswered requests keep loaded.
   * Requests over the cap are still served, but their documents are not
   * pinned. Defaults to {@link DEFAULT_MAX_PINNED_REQUESTS_PER_PEER};
   * `Infinity` disables the cap.
   */
  maxPinnedRequestsPerPeer?: number
}

interface CollectionSynchronizerEvents {
  message: (payload: MessageContents) => void
  "sync-state": (payload: SyncStatePayload) => void
  "open-doc": (arg: OpenDocMessage) => void
  metrics: (arg: DocSyncMetrics) => void
}

/**
 * CollectionSynchronizer manages the lifecycle of per-document synchronizers
 * and routes incoming messages to the correct DocSynchronizer. All share
 * policy decisions are delegated to the DocSynchronizer — this class is a
 * thin routing layer.
 */
export class CollectionSynchronizer
  extends EventEmitter<CollectionSynchronizerEvents>
  implements DocumentSource
{
  readonly priority: SourcePriority

  #peers: Set<PeerId> = new Set()

  /**
   * Per-document synchronizers, held weakly. A DocSynchronizer is retained
   * by its own document cluster (its handle listeners and query
   * subscription close over it) and by in-flight work (peer activation,
   * networkReady, sync-throttle timers), so an entry lives exactly as long
   * as its document. A later inbound message re-creates it via
   * ensureQuery/attach, re-loading persisted sync state.
   */
  #docSynchronizers = new WeakValueMap<DocumentId, DocSynchronizer>()

  /**
   * Synchronizers owing a peer an answer to its request, held strongly per
   * peer: nothing local references the document while we wait upstream on
   * the peer's behalf. Capped per peer by `maxPinnedRequestsPerPeer`.
   */
  #pinnedRequests = new Map<PeerId, Set<DocSynchronizer>>()
  #maxPinnedRequestsPerPeer: number

  /**
   * Documents each connected peer has sent a sync or request message for,
   * kept for the life of the connection. A synchronizer re-created after its
   * document was released reads it to resume sending to peers that asked
   * earlier, which a storage-less peer has no persisted sync state for.
   */
  #requestedBy = new Map<PeerId, Set<DocumentId>>()
  #denylist: DocumentId[]
  #config: AutomergeSyncConfig
  #networkReady: Promise<void>
  #log = makeLogger("automerge-repo:collectionsync")

  // Bounds the loadSyncState reads fanned out when peers are added to documents,
  // so a peer connecting to a many-document collection doesn't issue one storage
  // read per document at once.
  #loadSyncStateLimit: Limit

  // One shared limiter for every share-policy resolution in the collection, so
  // the concurrent user announce/access callbacks are capped across all
  // documents and peers together: both the per-peer resolution on addPeer and
  // the whole-collection re-evaluation on reevaluateDocumentShare draw from it.
  #sharePolicyLimit: Limit

  constructor(config: AutomergeSyncConfig, denylist: AutomergeUrl[] = []) {
    super()
    this.#networkReady = config.networkReady
    this.#config = config
    this.priority = config.priority
    this.#denylist = denylist.map(url => parseAutomergeUrl(url).documentId)
    this.#loadSyncStateLimit = semaphore(
      config.syncStateLoadConcurrency ?? DEFAULT_SYNC_STATE_LOAD_CONCURRENCY
    )
    this.#sharePolicyLimit = semaphore(
      config.sharePolicyConcurrency ?? SHARE_POLICY_CONCURRENCY
    )
    this.#maxPinnedRequestsPerPeer =
      config.maxPinnedRequestsPerPeer ?? DEFAULT_MAX_PINNED_REQUESTS_PER_PEER
    if (!(this.#maxPinnedRequestsPerPeer >= 0)) {
      throw new RangeError(
        `maxPinnedRequestsPerPeer must be a number >= 0, got ${config.maxPinnedRequestsPerPeer}`
      )
    }
  }

  /** Expose doc synchronizers for Repo access (e.g. metrics). A snapshot
   *  of the currently-live entries. */
  get docSynchronizers(): Record<DocumentId, DocSynchronizer> {
    return Object.fromEntries(this.#docSynchronizers.entries())
  }

  // DOCUMENT SOURCE INTERFACE

  /**
   * Register a document for syncing ({@link DocumentSource.attach}). If the
   * document is already registered this is a no-op. All connected peers are
   * immediately added to the DocSynchronizer — the DocSynchronizer evaluates
   * share policy internally.
   */
  attach(query: DocumentQuery<unknown>): void {
    if (this.#docSynchronizers.has(query.documentId)) return

    const docSync = this.#initDocSynchronizer(query.handle, query)
    this.#docSynchronizers.set(query.documentId, docSync)

    for (const peerId of this.#peers) {
      this.#addPeerToDoc(peerId, docSync, [])
    }
  }

  /** {@link DocumentSource.detach} — removes a document and stops syncing. */
  detach(documentId: DocumentId): void {
    this.#log.debug(`removing document ${documentId}`)
    const docSync = this.#docSynchronizers.get(documentId)
    if (docSync) {
      // Removing each peer also releases the requests it pinned.
      for (const peerId of this.peers) {
        docSync.removePeer(peerId)
      }
    }
    this.#docSynchronizers.delete(documentId)
  }

  // PEER MANAGEMENT

  addPeer(peerId: PeerId): void {
    this.#log.debug(`adding ${peerId} & synchronizing with them`)
    this.#peers.add(peerId)
    // A new connection starts a new record, even without a disconnect.
    this.#requestedBy.delete(peerId)
    for (const docSync of this.#docSynchronizers.values()) {
      this.#addPeerToDoc(peerId, docSync, [])
    }
  }

  removePeer(peerId: PeerId): void {
    this.#log.debug(`removing peer ${peerId}`)
    this.#peers.delete(peerId)
    for (const docSync of this.#docSynchronizers.values()) {
      docSync.removePeer(peerId)
    }
    this.#pinnedRequests.delete(peerId)
    this.#requestedBy.delete(peerId)
  }

  get peers(): PeerId[] {
    return Array.from(this.#peers)
  }

  // MESSAGE HANDLING

  receiveMessage(message: DocMessage): void {
    this.#log.debug(
      `onSyncMessage: ${message.senderId}, ${message.documentId}, ${
        "data" in message ? message.data.byteLength + "bytes" : ""
      }`
    )

    const documentId = message.documentId
    if (!documentId) {
      throw new Error("received a message with an invalid documentId")
    }

    if (this.#denylist.includes(documentId)) {
      this.emit("metrics", { type: "doc-denied", documentId })
      this.emit("message", {
        type: "doc-unavailable",
        documentId,
        targetId: message.senderId,
      })
      return
    }

    // Sync and request messages open per-peer state that only removePeer
    // releases, so they are accepted only from connected peers.
    if (
      (message.type === "sync" || message.type === "request") &&
      !this.#peers.has(message.senderId)
    ) {
      this.#log.debug(`ignoring ${message.type} from unknown peer`)
      return
    }

    if (message.type === "sync" || message.type === "request") {
      let requested = this.#requestedBy.get(message.senderId)
      if (!requested) {
        requested = new Set()
        this.#requestedBy.set(message.senderId, requested)
      }
      requested.add(documentId)
    }

    // Ensure we have a DocSynchronizer for this document.
    // ensureQuery calls attach which no-ops if already registered.
    let docSync = this.#docSynchronizers.get(documentId)
    if (!docSync) {
      this.#config.ensureQuery(documentId)
      docSync = this.#docSynchronizers.get(documentId)!
    }

    // Ephemeral and doc-unavailable messages may have a senderId that is
    // not a direct network peer (e.g. relayed ephemeral messages preserve
    // the original author's senderId). Route them directly to the
    // DocSynchronizer without trying to register the sender as a peer.
    if (message.type === "ephemeral" || message.type === "doc-unavailable") {
      docSync.receiveMessage(message)
      return
    }

    // For sync/request messages, ensure the sender is a peer on this doc
    // synchronizer. The incoming message is passed via `messages` so it is
    // queued and processed after persisted sync state loads, preserving
    // in-order delivery.
    if (!docSync.hasPeer(message.senderId)) {
      this.#addPeerToDoc(message.senderId, docSync, [message as any])
    } else {
      docSync.receiveMessage(message)
    }
  }

  // SHARE POLICY

  reevaluateDocumentShare(): void {
    for (const docSync of this.#docSynchronizers.values()) {
      docSync.reevaluateSharePolicy(this.#sharePolicyLimit)
    }
  }

  metrics(): {
    [key: string]: {
      peers: PeerId[]
      size: { numOps: number; numChanges: number }
    }
  } {
    return Object.fromEntries(
      Array.from(
        this.#docSynchronizers.entries(),
        ([documentId, synchronizer]) => {
          return [documentId, synchronizer.metrics()]
        }
      )
    )
  }

  // PRIVATE

  #initDocSynchronizer(
    handle: DocHandle<unknown>,
    query: DocumentQuery<unknown>
  ): DocSynchronizer {
    const docSync = new DocSynchronizer({
      handle,
      query,
      networkReady: this.#networkReady,
      shareConfig: this.#config.shareConfig,
      stampEphemeralMessage: this.#config.stampEphemeralMessage,
    })

    docSync.on("message", event => this.emit("message", event))
    docSync.on("open-doc", event => this.emit("open-doc", event))
    docSync.on("sync-state", event => this.emit("sync-state", event))
    docSync.on("metrics", event => this.emit("metrics", event))
    docSync.on("awaiting-answer", (peerId, awaiting) =>
      this.#setPinnedRequest(docSync, peerId, awaiting)
    )

    return docSync
  }

  #setPinnedRequest(
    docSync: DocSynchronizer,
    peerId: PeerId,
    awaiting: boolean
  ): void {
    let pinned = this.#pinnedRequests.get(peerId)
    if (!awaiting) {
      pinned?.delete(docSync)
      if (pinned?.size === 0) this.#pinnedRequests.delete(peerId)
      return
    }
    // A detached synchronizer is being torn down and a departed peer's pins
    // are already released: neither may pin.
    if (this.#docSynchronizers.get(docSync.documentId) !== docSync) return
    if (!this.#peers.has(peerId)) return
    // Over the cap the request is still served, but not pinned.
    if ((pinned?.size ?? 0) >= this.#maxPinnedRequestsPerPeer) return
    if (!pinned) {
      pinned = new Set()
      this.#pinnedRequests.set(peerId, pinned)
    }
    pinned.add(docSync)
  }

  #addPeerToDoc(
    peerId: PeerId,
    docSync: DocSynchronizer,
    messages: any[]
  ): void {
    const documentId = docSync.documentId

    docSync.addPeer(peerId, this.#loadSyncStateFor(documentId, peerId), {
      messages,
      limit: this.#sharePolicyLimit,
      hasRequested: this.#requestedBy.get(peerId)?.has(documentId) ?? false,
    })
  }

  #loadSyncStateFor(
    documentId: DocumentId,
    peerId: PeerId
  ): Promise<A.SyncState | undefined> {
    return this.#loadSyncStateLimit(
      () =>
        this.#config.loadSyncState?.(documentId, peerId) ??
        Promise.resolve(undefined)
    )
  }
}
