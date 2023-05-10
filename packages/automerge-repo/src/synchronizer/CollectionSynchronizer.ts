import { DocCollection } from "../DocCollection.js"
import { DocHandle } from "../DocHandle.js"
import { ChannelId, DocumentId, PeerId } from "../types.js"
import { DocSynchronizer } from "./DocSynchronizer.js"
import { Synchronizer } from "./Synchronizer.js"

import debug from "debug"
const log = debug("automerge-repo:collectionsync")

/** A CollectionSynchronizer is responsible for synchronizing a DocCollection with peers. */
export class CollectionSynchronizer extends Synchronizer {
  /** The set of peers we are connected with */
  #peers: Set<PeerId> = new Set()

  /** A map of documentIds to their synchronizers */
  #docSynchronizers: Record<DocumentId, DocSynchronizer> = {}

  constructor(private repo: DocCollection) {
    super()
  }

  /** Returns a synchronizer for the given document, creating one if it doesn't already exist.  */
  #fetchDocSynchronizer(documentId: DocumentId) {
    if (!this.#docSynchronizers[documentId]) {
      const handle = this.repo.find(documentId)
      this.#docSynchronizers[documentId] = this.#initDocSynchronizer(handle)
    }
    return this.#docSynchronizers[documentId]
  }

  /** Creates a new docSynchronizer and sets it up to propagate messages */
  #initDocSynchronizer(handle: DocHandle<unknown>): DocSynchronizer {
    const docSynchronizer = new DocSynchronizer(handle)
    docSynchronizer.on("message", event => this.emit("message", event))
    return docSynchronizer
  }

  /** returns an array of peerIds that we share this document generously with */
  async #documentGenerousPeers(documentId: DocumentId): Promise<PeerId[]> {
    const peers = Array.from(this.#peers)
    const generousPeers: PeerId[] = []
    for (const peerId of peers) {
      const okToShare = await this.repo.sharePolicy(peerId, documentId)
      if (okToShare) generousPeers.push(peerId)
    }
    return generousPeers
  }

  // PUBLIC

  /**
   * When we receive a sync message for a document we haven't got in memory, we
   * register it with the repo and start synchronizing
   */
  async receiveSyncMessage(
    peerId: PeerId,
    channelId: ChannelId,
    message: Uint8Array
  ) {
    log(`onSyncMessage: ${peerId}, ${channelId}, ${message.byteLength}bytes`)

    const documentId = channelId as unknown as DocumentId
    const docSynchronizer = await this.#fetchDocSynchronizer(documentId)

    await docSynchronizer.receiveSyncMessage(peerId, channelId, message)

    // Initiate sync with any new peers
    const peers = await this.#documentGenerousPeers(documentId)
    peers
      .filter(peerId => !docSynchronizer.hasPeer(peerId))
      .forEach(peerId => docSynchronizer.beginSync(peerId))
  }

  /**
   * Starts synchronizing the given document with all peers that we share it generously with.
   */
  addDocument(documentId: DocumentId) {
    const docSynchronizer = this.#fetchDocSynchronizer(documentId)
    void this.#documentGenerousPeers(documentId).then(peers => {
      peers.forEach(peerId => {
        docSynchronizer.beginSync(peerId)
      })
    })
  }

  // TODO: implement this
  removeDocument(documentId: DocumentId) {
    throw new Error("not implemented")
  }

  /** Adds a peer and maybe starts synchronizing with them */
  addPeer(peerId: PeerId) {
    log(`adding ${peerId} & synchronizing with them`)
    this.#peers.add(peerId)
    for (const docSynchronizer of Object.values(this.#docSynchronizers)) {
      const { documentId } = docSynchronizer
      void this.repo.sharePolicy(peerId, documentId).then(okToShare => {
        if (okToShare) docSynchronizer.beginSync(peerId)
      })
    }
  }

  /** Removes a peer and stops synchronizing with them */
  removePeer(peerId: PeerId) {
    log(`removing peer ${peerId}`)
    this.#peers.delete(peerId)

    for (const docSynchronizer of Object.values(this.#docSynchronizers)) {
      docSynchronizer.endSync(peerId)
    }
  }
}
