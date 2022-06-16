/** DocSynchronizer
 * Given a handle to an Automerge document,
 * receive & dispatch sync messages to bring it in-line with all other peers' versions.
 */
import EventEmitter from 'eventemitter3'
import * as Automerge from 'automerge-js'

export default class DocSynchronizer extends EventEmitter {
  handle

  // track this separately from syncStates because you might have more syncStates than active peers
  peers = []
  syncStates = {} // peer -> syncState

  constructor(handle) {
    super()
    this.handle = handle
    handle.on('change', () => this.syncWithPeers())
  }

  async getDoc() {
    const doc = await this.handle.value()
    if (!doc) { throw new Error('getDoc called with no document') }
    return doc
  }

  setDoc(doc) {
    if (!doc) { throw new Error('setDoc called with no document') }
    // this will trigger a peer sync due to the change listener above
    this.handle.replace(doc)
  }

  #getSyncState(peerId) {
    let syncState = this.syncStates[peerId]
    if (!syncState) {
      // TODO: load syncState from localStorage if available
      this.peers.push(peerId)
      syncState = Automerge.initSyncState()
    }
    return syncState
  }

  #setSyncState(peerId, syncState) {
    this.syncStates[peerId] = syncState
  }

  async #sendSyncMessage(peerId, documentId, doc) {
    const syncState = this.#getSyncState(peerId)
    const [newSyncState, message] = Automerge.generateSyncMessage(doc, syncState)
    this.#setSyncState(peerId, newSyncState)
    if (message) {
      this.emit('message', { peerId, documentId, message })
    }
  }

  async beginSync(peerId) {
    const { documentId } = this.handle
    const doc = await this.getDoc()
    this.#sendSyncMessage(peerId, documentId, doc)
  }

  endSync(peerId) {
    this.peers.filter((p) => p !== peerId)
  }

  async onSyncMessage(peerId, message) {
    let doc = await this.getDoc()
    let syncState = this.#getSyncState(peerId);
    [doc, syncState] = Automerge.receiveSyncMessage(doc, syncState, message)
    this.setDoc(doc)
    this.#setSyncState(peerId, syncState)
  }

  async syncWithPeers() {
    const { documentId } = this.handle
    const doc = await this.getDoc()
    this.peers.forEach((peerId) => {
      this.#sendSyncMessage(peerId, documentId, doc)
    })
  }
}
