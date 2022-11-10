import EventEmitter from "eventemitter3"
import debug from "debug"
const log = debug("CollectionSynchronizer")

import { DocSynchronizer } from "./DocSynchronizer.js"
import { DocCollection } from "../DocCollection.js"
import { SyncMessages } from "./Synchronizer.js"
import { DocHandle, DocumentId } from "../DocHandle.js"
import { ChannelId, PeerId } from "../network/NetworkSubsystem.js"

// When we get a peer for a channel, we want to offer it all the documents in this collection
// and subscribe to everything it offers us.
// In the real world, we probably want to authenticate the peer somehow,
// but we'll get to that later.
interface SyncPool {
  [docId: DocumentId]: DocSynchronizer
}
export class CollectionSynchronizer extends EventEmitter<SyncMessages> {
  repo: DocCollection
  peers: { [peerId: PeerId]: boolean /* share policy */ } = {}
  syncPool: SyncPool = {}

  constructor(repo: DocCollection) {
    super()
    this.repo = repo
  }

  async onSyncMessage(
    peerId: PeerId,
    channelId: ChannelId,
    message: Uint8Array
  ) {
    const documentId = channelId as unknown as DocumentId

    // if we receive a sync message for a document we haven't got in memory,
    // we'll need to register it with the repo and start synchronizing
    const docSynchronizer = await this.fetchDocSynchronizer(documentId)
    log(`onSyncMessage: ${peerId}, ${channelId}, ${message}`)
    docSynchronizer.onSyncMessage(peerId, channelId, message)
    this.__generousPeers().forEach((peerId) => {
      if (!docSynchronizer.peers.includes(peerId)) {
        docSynchronizer.beginSync(peerId)
      }
    })
  }

  async fetchDocSynchronizer(documentId: DocumentId) {
    // TODO: we want a callback to decide to accept offered documents
    if (!this.syncPool[documentId]) {
      const handle = await this.repo.find(documentId)
      this.syncPool[documentId] =
        this.syncPool[documentId] || this.initDocSynchronizer(handle)
    }
    return this.syncPool[documentId]
  }

  initDocSynchronizer(handle: DocHandle<unknown>): DocSynchronizer {
    const docSynchronizer = new DocSynchronizer(handle)
    docSynchronizer.on("message", (event) => this.emit("message", event))
    return docSynchronizer
  }

  async addDocument(documentId: DocumentId) {
    const docSynchronizer = await this.fetchDocSynchronizer(documentId)
    this.__generousPeers().forEach((peerId) =>
      docSynchronizer.beginSync(peerId)
    )
  }

  // need a removeDocument implementation

  // return an array of peers where sharePolicy
  __generousPeers(): PeerId[] {
    return Object.entries(this.peers)
      .filter(([, sharePolicy]) => sharePolicy === true)
      .map(([p]) => p as PeerId)
  }

  addPeer(peerId: PeerId, sharePolicy: boolean) {
    log(`${peerId}, ${sharePolicy}`)
    this.peers[peerId] = sharePolicy
    if (sharePolicy === true) {
      log(`sharing all open docs`)
      Object.values(this.syncPool).forEach((docSynchronizer) =>
        docSynchronizer.beginSync(peerId)
      )
    }
  }

  // TODO: need to handle vanishing peers somehow and deliberately removing them
}
