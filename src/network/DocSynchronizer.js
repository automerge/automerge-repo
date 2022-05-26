/* global Automerge */
export default class DocSynchronizer extends EventTarget {
  handle
  peers = []
  syncStates = {} // peer -> syncState

  constructor(handle) {
    super()
    this.handle = handle
    handle.addEventListener('change', () => this.syncWithPeers())
  }

  async beginSync(peerId) {
    const { documentId } = this.handle
    if (!this.syncStates[peerId]) {
      // TODO: load syncState from localStorage if available
      this.peers.push(peerId)
      this.syncStates[peerId] = Automerge.initSyncState()
    }

    // Start sync by sending a first message.
    // Both parties should do this.
    const [syncState, message] = Automerge.generateSyncMessage(
      await this.handle.value(),
      this.syncStates[peerId],
    )
    this.syncStates[peerId] = syncState
    if (message) {
      this.dispatchEvent(new CustomEvent('message', { detail: { peerId, documentId, message } }))
    }
  }

  endSync(peerId) {
    this.peers.filter((p) => p !== peerId)
    // TODO
  }

  async onSyncMessage(peerId, message) {
    const { handle } = this
    let doc = await handle.value()
    if (!doc) { throw new Error('onSyncMessage called with no document') }
    let syncState = this.syncStates[peerId]

    if (!syncState) {
      // TODO: load syncState from localStorage if available
      this.peers.push(peerId)
      syncState = Automerge.initSyncState()
    }

    [doc, syncState] = Automerge.receiveSyncMessage(doc, syncState, message)
    this.syncStates[peerId] = syncState
    handle.replace(doc)
    // this will trigger a peer sync due to a change in doc contents
  }

  syncWithPeers() {
    const { documentId, doc } = this.handle
    this.peers.forEach((peerId) => {
      const syncState = this.syncStates[peerId]
      const [newSyncState, message] = Automerge.generateSyncMessage(doc, syncState)
      this.syncStates[peerId] = newSyncState
      if (message) {
        this.dispatchEvent(new CustomEvent('message', { detail: { peerId, documentId, message } }))
      }
    })
  }
}
