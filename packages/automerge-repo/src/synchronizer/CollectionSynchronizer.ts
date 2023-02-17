import { DocCollection } from "../DocCollection"
import { DocHandle } from "../DocHandle"
import { ChannelId, DocumentId, PeerId } from "../types"
import { DocSynchronizer } from "./DocSynchronizer"
import { Synchronizer } from "./Synchronizer"

import debug from "debug"
const log = debug("automerge-repo:collectionsync")

/** A CollectionSynchronizer is responsible for synchronizing a DocCollection with peers. */
export class CollectionSynchronizer extends Synchronizer {
  repo: DocCollection

  /** ? */
  #peers: Set<PeerId> = new Set()

  /** A map of documentIds to their synchronizers */
  #syncPool: Record<DocumentId, DocSynchronizer> = {}

  constructor(repo: DocCollection) {
    super()
    this.repo = repo
  }

  /**
   * When we receive a sync message for a document we haven't got in memory, we
   * register it with the repo and start synchronizing
   */
  async onSyncMessage(
    peerId: PeerId,
    channelId: ChannelId,
    message: Uint8Array
  ) {
    log(`onSyncMessage: ${peerId}, ${channelId}, ${message}`)

    const documentId = channelId as unknown as DocumentId
    const docSynchronizer = await this.#fetchDocSynchronizer(documentId)

    docSynchronizer.onSyncMessage(peerId, channelId, message)
    const peers = await this.#documentGenerousPeers(documentId)
    peers.forEach(peerId => {
      if (!docSynchronizer.hasPeer(peerId)) {
        docSynchronizer.beginSync(peerId)
      }
    })
  }

  /** Returns a synchronizer for the given document, creating one if it doesn't already exist.  */
  async #fetchDocSynchronizer(documentId: DocumentId) {
    if (!this.#syncPool[documentId]) {
      const handle = await this.repo.find(documentId)
      this.#syncPool[documentId] = this.#initDocSynchronizer(handle)
    }
    return this.#syncPool[documentId]
  }

  #initDocSynchronizer(handle: DocHandle<unknown>): DocSynchronizer {
    const docSynchronizer = new DocSynchronizer(handle)
    docSynchronizer.on("message", event => this.emit("message", event))
    return docSynchronizer
  }

  /**
   * Starts synchronizing the given document with all peers that we share it generously with.
   */
  async addDocument(documentId: DocumentId) {
    const docSynchronizer = await this.#fetchDocSynchronizer(documentId)
    const peers = await this.#documentGenerousPeers(documentId)
    peers.forEach(peerId => {
      docSynchronizer.beginSync(peerId)
    })
  }

  // TODO: implement this
  removeDocument(documentId: DocumentId) {
    throw new Error("not implemented")
  }

  /** returns an array of peerIds that we share this document generously with */
  async #documentGenerousPeers(documentId: DocumentId): Promise<PeerId[]> {
    const results = await Promise.all(
      [...this.#peers].map(peerId => this.repo.sharePolicy(peerId, documentId))
    )

    return [...this.#peers].filter((_, index) => results[index])
  }

  /** Adds a peer and maybe starts synchronizing with them */
  addPeer(peerId: PeerId) {
    log(`${peerId} added`)
    this.#peers.add(peerId)
    log(`sharing all open docs`)
    Object.values(this.#syncPool).forEach(async docSynchronizer => {
      if (await this.repo.sharePolicy(peerId, docSynchronizer.documentId)) {
        docSynchronizer.beginSync(peerId)
      }
    })
  }

  /** Removes a peer and stops synchronizing with them */
  removePeer(peerId: PeerId) {
    log(`removing peer ${peerId}`)
    this.#peers.delete(peerId)

    for (const docSynchronizer of Object.values(this.#syncPool)) {
      docSynchronizer.endSync(peerId)
    }
  }
}
