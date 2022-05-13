import DocSynchronizer from './DocSynchronizer.js'

// This collection synchronizer simply joins a channel for every document
// and blindly synchronizes with anyone on that channel.

export default class SimpleCollectionSynchronizer {
  syncPool = {}
  constructor(networkSubsystem, repo) {
    networkSubsystem.addEventListener('peer', (ev) => {
      const { peer, channel: documentId } = ev.detail
      const docSynchronizer = this.syncPool[documentId] || new DocSynchronizer(repo.get(documentId))
      docSynchronizer.beginSync(peer)

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
    })

    repo.addEventListener('document', (ev) => {
      const { handle } = ev.detail
      const { documentId } = handle
      this.syncPool[documentId] = this.syncPool[documentId] || new DocSynchronizer(handle)
      networkSubsystem.join(documentId)
    })
  }
}
