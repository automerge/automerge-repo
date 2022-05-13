export default class DocSynchronizer {
  docHandle
  peers = []
  syncStates = {} // peer -> syncState

  constructor(handle) {
    this.handle = handle
    handle.addEventListener('change', () => this.syncWithPeers())
  }

  beginSync(peer) {
    const { documentId } = this.handle
    if (!this.syncStates[peer.id]) {
      // TODO: load syncState from localStorage if available
      this.peers.push(peer)
      this.syncStates[peer.id] = Automerge.initSyncState()
    }

    // Start sync by sending a first message.
    // Both parties should do this.
    const [syncState, msg] = Automerge.generateSyncMessage(
      this.handle.value(),
      this.syncStates[peer.id],
    )
    this.syncStates[peer.id][documentId] = syncState
    if (msg) {
      peer.send(msg)
    }
  }

  onSyncMessage(peer, message) {
    const { handle } = this
    let doc = handle.value()

    let syncState = this.syncStates[peer.id][handle.documentId];
    [doc, syncState] = Automerge.receiveSyncMessage(doc, syncState, message)
    this.syncStates[peer.id][handle.documentId] = syncState
    handle.replace(doc)

    this.syncWithPeers()
  }

  syncWithPeers() {
    const { documentId, doc } = this.handle
    this.peers = this.peers.filter((p) => p.isOpen())
    this.peers.forEach((peer) => {
      const syncState = this.syncStates[peer.id][documentId]
      const [newSyncState, message] = Automerge.generateSyncMessage(doc, syncState)
      this.syncStates[peer.id][documentId] = newSyncState
      if (message) {
        peer.send(message)
      }
    })
  }
}
