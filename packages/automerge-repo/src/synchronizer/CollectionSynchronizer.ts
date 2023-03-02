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

  /** A map of our peers to whether we share generously with them or not */
  #peers: Record<PeerId, boolean> = {}

  /** A map of documentIds to their synchronizers */
  #syncPool: Record<DocumentId, DocSynchronizer> = {}

  constructor(repo: DocCollection) {
    super()
    this.repo = repo
  }

  /**
   *
   */
  onSyncMessage(peerId: PeerId, channelId: ChannelId, message: Uint8Array) {
    const documentId = channelId as unknown as DocumentId

    // if we receive a sync message for a document we haven't got in memory,
    // we'll need to register it with the repo and start synchronizing
    const docSynchronizer = this.fetchDocSynchronizer(documentId)
    log(`onSyncMessage: ${peerId}, ${channelId}, ${message}`)
    docSynchronizer.onSyncMessage(peerId, channelId, message)
    this.#generousPolicyPeers().forEach(peerId => {
      if (!docSynchronizer.hasPeer(peerId)) {
        docSynchronizer.beginSync(peerId)
      }
    })
  }

  /** Returns a synchronizer for the given document, creating one if it doesn't already exist.  */
  fetchDocSynchronizer(documentId: DocumentId) {
    // TODO: add a callback to decide whether or not to accept offered documents

    if (!this.#syncPool[documentId]) {
      const handle = this.repo.find(documentId)
      this.#syncPool[documentId] = this.initDocSynchronizer(handle)
    }
    return this.#syncPool[documentId]
  }

  initDocSynchronizer(handle: DocHandle<unknown>): DocSynchronizer {
    const docSynchronizer = new DocSynchronizer(handle)
    docSynchronizer.on("message", event => this.emit("message", event))
    return docSynchronizer
  }

  /**
   * Starts synchronizing the given document with all peers that we share generously with.
   */
  addDocument(documentId: DocumentId) {
    const docSynchronizer = this.fetchDocSynchronizer(documentId)
    this.#generousPolicyPeers().forEach(peerId =>
      docSynchronizer.beginSync(peerId)
    )
  }

  // TODO: implement this
  removeDocument(documentId: DocumentId) {
    throw new Error("not implemented")
  }

  /** returns an array of peerIds that we share generously with */
  #generousPolicyPeers(): PeerId[] {
    return Object.entries(this.#peers)
      .filter(([_, shareGenerous]) => shareGenerous === true)
      .map(([peerId, _]) => peerId as PeerId)
  }

  /** Adds a peer and maybe starts synchronizing with them */
  addPeer(
    peerId: PeerId,

    /**
     * If true, we share generously with this peer. ("Generous" means we tell them about every
     * document we have, whether or not they ask for them.)
     * */
    generousPolicy: boolean
  ) {
    log(`${peerId}, ${generousPolicy}`)
    this.#peers[peerId] = generousPolicy
    if (generousPolicy === true) {
      log(`sharing all open docs`)
      Object.values(this.#syncPool).forEach(docSynchronizer =>
        docSynchronizer.beginSync(peerId)
      )
    }
  }

  /** Removes a peer and stops synchronizing with them */
  removePeer(peerId: PeerId) {
    log(`removing peer ${peerId}`)
    delete this.#peers[peerId]
    for (const docSynchronizer of Object.values(this.#syncPool)) {
      docSynchronizer.endSync(peerId)
    }
  }
}
