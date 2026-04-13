import { next as A } from "@automerge/automerge/slim"
import debug from "debug"
import { EventEmitter } from "eventemitter3"
import { DocHandle } from "../DocHandle.js"
import { parseAutomergeUrl } from "../AutomergeUrl.js"
import {
  DocMessage,
  MessageContents,
  OpenDocMessage,
} from "../network/messages.js"
import { AutomergeUrl, DocumentId, PeerId } from "../types.js"
import { DocSynchronizer } from "./DocSynchronizer.js"
import type { ShareConfig } from "./DocSynchronizer.js"
import type { DocumentSource } from "../DocumentSource.js"
import type { DocumentQuery } from "../DocumentQuery.js"
import type { SyncStatePayload, DocSyncMetrics } from "./Synchronizer.js"

const log = debug("automerge-repo:collectionsync")

export interface AutomergeSyncConfig {
  peerId: PeerId

  shareConfig: ShareConfig

  /**
   * Called when the sync layer receives a message for a document it doesn't
   * have a DocSynchronizer for. The Repo creates the query/handle, calls
   * attach, and returns the handle and query.
   */
  ensureHandle: (documentId: DocumentId) => DocumentQuery<unknown>

  /**
   * Load persisted sync state for a peer on a specific document. Returns
   * undefined if no sync state is available.
   */
  loadSyncState?: (
    documentId: DocumentId,
    peerId: PeerId
  ) => Promise<A.SyncState | undefined>

  /**
   * Resolves when the network layer is ready to send messages.
   * Documents created before this resolves get a "network" source
   * registered on their query to keep them in "loading" state until
   * peers have had a chance to connect.
   */
  networkReady: Promise<void>
}

interface CollectionSynchronizerEvents {
  message: (payload: MessageContents) => void
  "sync-state": (payload: SyncStatePayload) => void
  "open-doc": (arg: OpenDocMessage) => void
  metrics: (arg: DocSyncMetrics) => void
}

/**
 * CollectionSynchronizer manages the lifecycle of per-document synchronizers
 * and routes incoming messages to the correct DocSynchronizer.
 */
export class CollectionSynchronizer
  extends EventEmitter<CollectionSynchronizerEvents>
  implements DocumentSource
{
  #peers: Set<PeerId> = new Set()
  #docSynchronizers: Record<DocumentId, DocSynchronizer> = {}
  #denylist: DocumentId[]
  #config: AutomergeSyncConfig
  #networkReady: Promise<void>

  constructor(config: AutomergeSyncConfig, denylist: AutomergeUrl[] = []) {
    super()
    this.#networkReady = config.networkReady
    this.#config = config
    this.#denylist = denylist.map(url => parseAutomergeUrl(url).documentId)
  }

  /** Expose doc synchronizers for Repo access (e.g. metrics) */
  get docSynchronizers(): Record<DocumentId, DocSynchronizer> {
    return this.#docSynchronizers
  }

  // DOCUMENT SOURCE INTERFACE

  /**
   * Register a document for syncing ({@link DocumentSource.attach}). If the
   * document is already registered this is a no-op.
   */
  attach(query: DocumentQuery<unknown>): void {
    if (this.#docSynchronizers[query.documentId]) return

    const docSync = this.#initDocSynchronizer(query.handle, query)
    this.#docSynchronizers[query.documentId] = docSync

    for (const peerId of this.#peers) {
      this.#addPeerToDoc(peerId, docSync, [])
    }
  }

  /** {@link DocumentSource.detach} — removes a document and stops syncing. */
  detach(documentId: DocumentId): void {
    log(`removing document ${documentId}`)
    const docSync = this.#docSynchronizers[documentId]
    if (docSync) {
      for (const peerId of this.peers) {
        docSync.removePeer(peerId)
      }
    }
    delete this.#docSynchronizers[documentId]
  }

  // PEER MANAGEMENT

  addPeer(peerId: PeerId): void {
    log(`adding ${peerId} & synchronizing with them`)
    if (this.#peers.has(peerId)) return

    this.#peers.add(peerId)
    for (const docSync of Object.values(this.#docSynchronizers)) {
      this.#addPeerToDoc(peerId, docSync, [])
    }
  }

  removePeer(peerId: PeerId): void {
    log(`removing peer ${peerId}`)
    this.#peers.delete(peerId)
    for (const docSync of Object.values(this.#docSynchronizers)) {
      docSync.removePeer(peerId)
    }
  }

  get peers(): PeerId[] {
    return Array.from(this.#peers)
  }

  // MESSAGE HANDLING

  receiveMessage(message: DocMessage): void {
    log(
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

    // Ensure we have a DocSynchronizer for this document.
    // ensureHandle calls this.attach which no-ops if already registered.
    let docSync = this.#docSynchronizers[documentId]
    if (!docSync) {
      this.#config.ensureHandle(documentId)
      // ensureHandle should have synchronously registered a DocSynchronizer via
      // this.attach so it should now be present in this.#docSynchronizers
      docSync = this.#docSynchronizers[documentId]!
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
    // synchronizer. The incoming message is passed to addPeerToDoc so it is
    // queued and processed after persisted sync state loads, preserving
    // in-order delivery.
    if (!docSync.hasPeer(message.senderId)) {
      this.#addPeerToDoc(message.senderId, docSync, [message as any])
    } else {
      docSync.receiveMessage(message)
    }
  }

  // SHARE POLICY

  shareConfigChanged(): void {
    for (const docSync of Object.values(this.#docSynchronizers)) {
      docSync.reevaluateSharePolicy()
    }
  }

  metrics(): {
    [key: string]: {
      peers: PeerId[]
      size: { numOps: number; numChanges: number }
    }
  } {
    return Object.fromEntries(
      Object.entries(this.#docSynchronizers).map(
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
    })

    docSync.on("message", event => this.emit("message", event))
    docSync.on("open-doc", event => this.emit("open-doc", event))
    docSync.on("sync-state", event => this.emit("sync-state", event))
    docSync.on("metrics", event => this.emit("metrics", event))

    return docSync
  }

  #addPeerToDoc(
    peerId: PeerId,
    docSync: DocSynchronizer,
    messages: any[]
  ): void {
    const documentId = docSync.documentId

    docSync.addPeer(peerId, this.#loadSyncStateFor(documentId, peerId), {
      messages,
    })
  }

  #loadSyncStateFor(
    documentId: DocumentId,
    peerId: PeerId
  ): Promise<A.SyncState | undefined> {
    return (
      this.#config.loadSyncState?.(documentId, peerId) ??
      Promise.resolve(undefined)
    )
  }
}
