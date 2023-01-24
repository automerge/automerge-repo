import { DocCollection } from "../DocCollection.js"
import { DocHandle } from "../DocHandle.js"
import { ChannelId, DocumentId, PeerId } from "../types.js"
import { DocSynchronizer } from "./DocSynchronizer.js"
import { Synchronizer } from "./Synchronizer.js"

import debug from "debug"
const log = debug("ar:collectionsync")

/** A CollectionSynchronizer is responsible for synchronizing a DocCollection with peers. */
export class CollectionSynchronizer extends Synchronizer {
  /** A map of our peers to whether we share generously with them or not */
  #peers: Record<PeerId, boolean> = {}

  /** A map of documentIds to their document synchronizers */
  #docSynchronizers: Record<DocumentId, DocSynchronizer> = {}

  constructor(private repo: DocCollection) {
    super()
  }

  /**
   * When we receive a sync message, we hand it off to the appropriate document synchronizer. Once
   * the document synchronizer has updated the document, we update our peers.
   */
  receiveSyncMessage(
    peerId: PeerId,
    channelId: ChannelId,
    message: Uint8Array
  ) {
    log(`onSyncMessage: ${peerId}, ${channelId}, ${message}`)

    const documentId = channelId as string as DocumentId

    // Have the doc synchronizer handle the message & update document accordingly
    const docSynchronizer = this.#fetchDocSynchronizer(documentId)
    docSynchronizer.receiveSyncMessage(peerId, channelId, message)

    // Let any peers know about the change (if we share generously with them)
    this.#generousPolicyPeers().forEach(peerId => {
      if (!docSynchronizer.hasPeer(peerId)) docSynchronizer.beginSync(peerId)
    })
  }

  /** Returns a synchronizer for the given document, creating one if it doesn't already exist.  */
  #fetchDocSynchronizer(documentId: DocumentId) {
    // TODO: add a callback to decide whether or not to accept offered documents

    if (!this.#docSynchronizers[documentId]) {
      const handle = this.repo.find(documentId)
      const docSynchronizer = new DocSynchronizer(handle)
      // re-emit this synchronizer's messages
      docSynchronizer.on("message", payload => this.emit("message", payload))

      this.#docSynchronizers[documentId] = docSynchronizer
    }
    return this.#docSynchronizers[documentId]
  }

  /** Starts synchronizing the given document with all peers that we share generously with. */
  addDocument(documentId: DocumentId) {
    const docSynchronizer = this.#fetchDocSynchronizer(documentId)
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
     */
    generousPolicy: boolean
  ) {
    log(`${peerId}, ${generousPolicy}`)
    this.#peers[peerId] = generousPolicy
    if (generousPolicy === true) {
      log(`sharing all open docs`)
      Object.values(this.#docSynchronizers).forEach(docSynchronizer =>
        docSynchronizer.beginSync(peerId)
      )
    }
  }

  /** Removes a peer and stops synchronizing with them */
  removePeer(peerId: PeerId) {
    log(`removing peer ${peerId}`)
    delete this.#peers[peerId]
    for (const docSynchronizer of Object.values(this.#docSynchronizers)) {
      docSynchronizer.endSync(peerId)
    }
  }
}
