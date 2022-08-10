import EventEmitter from 'eventemitter3'
import * as CBOR from 'cbor-x'

import DocSynchronizer from './DocSynchronizer.js'

// When we get a peer for a channel, we want to offer it all the documents in this collection
// and subscribe to everything it offers us.
// In the real world, we probably want to authenticate the peer somehow,
// but we'll get to that later.
export default class CollectionSynchronizer extends EventEmitter {
  peers = []
  syncPool = {}

  constructor(repo) {
    super()
    this.repo = repo
  }

  async onSyncMessage(peerId, wrappedMessage) {
    const contents = CBOR.decode(wrappedMessage)
    const { documentId, message } = contents

    // if we receive a sync message for a document we haven't got in memory,
    // we'll need to register it with the repo and start synchronizing
    const docSynchronizer = await this.fetchDocSynchronizer(documentId)
    docSynchronizer.onSyncMessage(peerId, message)
  }

  async fetchDocSynchronizer(documentId) {
    // TODO: we want a callback to decide to accept offered documents
    if (!this.syncPool[documentId]) {
      const handle = await this.repo.find(documentId)
      this.syncPool[documentId] = this.syncPool[documentId] || this.initDocSynchronizer(handle)
    }
    return this.syncPool[documentId]
  }

  initDocSynchronizer(handle) {
    const docSynchronizer = new DocSynchronizer(handle)
    docSynchronizer.on('message', ({ peerId, documentId, message }) => {
      const newmsg = CBOR.encode({ documentId, message })
      this.emit('message', { peerId, message: newmsg })
    })
    return docSynchronizer
  }

  async addDocument(documentId) {
    const docSynchronizer = await this.fetchDocSynchronizer(documentId)
    this.peers.forEach((peerId) => docSynchronizer.beginSync(peerId))
  }

  // need a removeDocument implementation

  addPeer(peerId) {
    console.log("adding, ", peerId)
    this.peers.push(peerId)
    Object.values(this.syncPool).forEach((docSynchronizer) => docSynchronizer.beginSync(peerId))
  }

  // need to handle vanishing peers somehow and deliberately removing them
}
