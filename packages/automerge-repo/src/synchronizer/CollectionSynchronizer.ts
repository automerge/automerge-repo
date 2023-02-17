import EventEmitter from "eventemitter3"
import debug from "debug"
import { DocSynchronizer } from "./DocSynchronizer.js"
import { DocCollection } from "../DocCollection.js"
import { SyncMessages } from "./Synchronizer.js"
import { DocHandle, DocumentId } from "../DocHandle.js"
import { ChannelId, PeerId } from "../network/NetworkSubsystem.js"

const log = debug("CollectionSynchronizer")

// When we get a peer for a channel, we want to offer it all the documents in this collection
// and subscribe to everything it offers us.
// In the real world, we probably want to authenticate the peer somehow,
// but we'll get to that later.
interface SyncPool {
  [docId: DocumentId]: DocSynchronizer
}
export class CollectionSynchronizer extends EventEmitter<SyncMessages> {
  repo: DocCollection
  peers: Set<PeerId> = new Set()
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
    const docSynchronizer = await this.#fetchDocSynchronizer(documentId)
    log(`onSyncMessage: ${peerId}, ${channelId}, ${message}`)
    docSynchronizer.onSyncMessage(peerId, channelId, message)
    ;(await this.#documentGenerousPeers(documentId)).forEach(peerId => {
      if (!docSynchronizer.peers.includes(peerId)) {
        docSynchronizer.beginSync(peerId)
      }
    })
  }

  async #fetchDocSynchronizer(documentId: DocumentId) {
    if (!this.syncPool[documentId]) {
      const handle = await this.repo.find(documentId)
      this.syncPool[documentId] = this.#initDocSynchronizer(handle)
    }
    return this.syncPool[documentId]
  }

  #initDocSynchronizer(handle: DocHandle<unknown>): DocSynchronizer {
    const docSynchronizer = new DocSynchronizer(handle)
    docSynchronizer.on("message", event => this.emit("message", event))
    return docSynchronizer
  }

  async addDocument(documentId: DocumentId) {
    const docSynchronizer = await this.#fetchDocSynchronizer(documentId)
    ;(await this.#documentGenerousPeers(documentId)).forEach(peerId => {
      docSynchronizer.beginSync(peerId)
    })
  }

  // need a removeDocument implementation

  // return an array of peers where sharePolicy
  async #documentGenerousPeers(documentId: DocumentId): Promise<PeerId[]> {
    const results = await Promise.all(
      [...this.peers].map(peerId => this.repo.sharePolicy(peerId, documentId))
    )

    return [...this.peers].filter((_v, index) => results[index])
  }

  addPeer(peerId: PeerId) {
    log(`${peerId} added`)
    this.peers.add(peerId)
    log(`sharing all open docs`)
    Object.values(this.syncPool).forEach(async docSynchronizer => {
      if (await this.repo.sharePolicy(peerId, docSynchronizer.documentId)) {
        docSynchronizer.beginSync(peerId)
      }
    })
  }

  removePeer(peerId: PeerId) {
    log(`removing peer ${peerId}`)
    this.peers.delete(peerId)

    for (const docSynchronizer of Object.values(this.syncPool)) {
      docSynchronizer.endSync(peerId)
    }
  }
}
