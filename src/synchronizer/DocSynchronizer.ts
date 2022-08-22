/** DocSynchronizer
 * Given a handle to an Automerge document,
 * receive & dispatch sync messages to bring it in-line with all other peers' versions.
 */
import EventEmitter from 'eventemitter3'
import { Synchronizer, SyncMessages } from './Synchronizer'
import * as Automerge from 'automerge-js'
import DocHandle from '../DocHandle'

export default class DocSynchronizer extends EventEmitter<SyncMessages> implements Synchronizer {
  handle

  // track this separately from syncStates because you might have more syncStates than active peers
  peers: string[] = []
  syncStates: { [peerId: string] : Automerge.SyncState } = {} // peer -> syncState

  constructor(handle: DocHandle<unknown>) {
    super()
    this.handle = handle
    handle.on('change', () => this.syncWithPeers())
  }

  async getDoc() {
    const doc = await this.handle.value()
    if (!doc) { throw new Error('getDoc called with no document') }
    return doc
  }

  setDoc(doc: Automerge.Doc<unknown>, initialHeads?: string[], newHeads?: string[]) {
    if (!doc) { throw new Error('setDoc called with no document') }
    // this will trigger a peer sync due to the change listener above
    this.handle.replace(doc, initialHeads, newHeads)
  }

  getSyncState(peerId: string) {
    if (!peerId) { throw new Error("Tried to load a missing peerId") }

    let syncState = this.syncStates[peerId]
    if (!syncState) {
      // TODO: load syncState from localStorage if available
      console.log('adding a new peer', peerId)
      this.peers.push(peerId)
      syncState = Automerge.initSyncState()
    }
    return syncState
  }

  setSyncState(peerId: string, syncState: Automerge.SyncState) {
    this.syncStates[peerId] = syncState
  }

  async sendSyncMessage(peerId: string, documentId: string, doc: Automerge.Doc<unknown>) {
    const syncState = this.getSyncState(peerId)
    const [newSyncState, message] = Automerge.generateSyncMessage(doc, syncState)
    this.setSyncState(peerId, newSyncState)
    if (message) {
      this.emit('message', { peerId, documentId, message })
    }
  }

  async beginSync(peerId: string) {
    const { documentId } = this.handle
    const doc = await this.getDoc()
    this.sendSyncMessage(peerId, documentId, doc)
  }

  endSync(peerId: string) {
    this.peers.filter((p) => p !== peerId)
  }

  async onSyncMessage(peerId: string, message: Uint8Array) {
    let doc = await this.getDoc()
    const initialHeads = (Automerge as any).getBackend(doc).getHeads()
    console.log('on sync message', peerId)
    let syncState = this.getSyncState(peerId);
    [doc, syncState] = Automerge.receiveSyncMessage(doc, syncState, message)
    const newHeads = (Automerge as any).getBackend(doc).getHeads()
    this.setDoc(doc, initialHeads, newHeads)
    this.setSyncState(peerId, syncState)
  }

  async syncWithPeers() {
    console.log("syncing with peers")
    const { documentId } = this.handle
    const doc = await this.getDoc()
    this.peers.forEach((peerId) => {
      console.log('messaging peer', peerId)
      this.sendSyncMessage(peerId, documentId, doc)
    })
  }
}
