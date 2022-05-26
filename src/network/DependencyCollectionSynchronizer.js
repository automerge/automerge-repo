/* global CBOR */

import DocSynchronizer from './DocSynchronizer.js'
import '../../vendor/cbor-x.js' // Creates CBOR object in global namespace. Uh. TODO.

// When we get a peer for a channel, we want to offer it all the documents in this collection
// and subscribe to everything it offers us.
// In the real world, we probably want to authenticate the peer somehow,
// but we'll get to that later.
export default class CollectionSynchronizer extends EventTarget {
  channel
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
    if (!this.syncPool[documentId]) {
      // TODO: need to think through the GLR process
      const handle = await this.repo.getOrLoadOrRequest(documentId)
      this.syncPool[documentId] = this.syncPool[documentId]
        || this.initializeDocSynchronizer(handle)
      // TODO this.syncPool[documentId].beginSync(peer)
    }
    return this.syncPool[documentId]
  }

  initializeDocSynchronizer(handle) {
    const docSynchronizer = new DocSynchronizer(handle)
    docSynchronizer.addEventListener('message', (ev) => {
      const { peerId, documentId, message } = ev.detail
      const newmsg = CBOR.encode({ documentId, message })
      this.dispatchEvent(new CustomEvent('message', { detail: { peerId, message: newmsg } }))
    })
    return docSynchronizer
  }

  async addDocument(documentId) {
    const docSynchronizer = await this.fetchDocSynchronizer(documentId)
    this.peers.forEach((peerId) => docSynchronizer.beginSync(peerId))
  }

  // need a removeDocument implementation

  addPeer(peerId) {
    this.peers.push(peerId)
    Object.values(this.syncPool).forEach((docSynchronizer) => docSynchronizer.beginSync(peerId))
  }

  // need to handle vanishing peers somehow and deliberately removing them
}
