/* eslint-disable max-classes-per-file */
import DocSynchronizer from './DocSynchronizer.js'

// This collection synchronizer shares any open docs
// with anyone else who wants to listen to those docs.
export default class ExplicitShareCollectionSynchronizer {
  onPeer(ev, repo) {
    const { peer, channel: documentId } = ev.detail
    const docSynchronizer = this.syncPool[documentId] || new DocSynchronizer(repo.get(documentId))
    docSynchronizer.beginSync(peer)
    this.syncPool[documentId] = docSynchronizer

    peer.addEventListener('message', (mev) => {
      const { channel, message } = mev.detail
      const handle = this.syncPool[channel]
      if (handle) {
        handle.onSyncMessage(peer, message)
      } else {
        // TODO: we should probably try to load or create the document someone's offering us
        throw new Error("Received a sync message for a document we didn't register.\n"
                      + "This hasn't been implemented yet.")
      }
    })
  }

  onOffer(ev, repo) {
    const { peer, documentId } = ev.detail
    if (!repo.get(documentId)) {
      repo.create(documentId)
      const docSynchronizer = new DocSynchronizer(repo.get(documentId))
      docSynchronizer.beginSync(peer)
      this.syncPool[documentId] = docSynchronizer
    }
  }

  onDocument(ev) {
    const { handle } = ev.detail
    const { documentId } = handle
    this.syncPool[documentId] = this.syncPool[documentId] || new DocSynchronizer(handle)
  }

  // TODO: this is wrong! need per-peer/docId sync state
  syncPool = {}
}
