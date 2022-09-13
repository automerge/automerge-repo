/** DocSynchronizer
 * Given a handle to an Automerge document,
 * receive & dispatch sync messages to bring it in-line with all other peers' versions.
 */
import EventEmitter from 'eventemitter3'
import { Synchronizer, SyncMessages } from './Synchronizer'
import * as Automerge from 'automerge-js'
import DocHandle from '../DocHandle'

export default class DocSynchronizer extends EventEmitter<SyncMessages> implements Synchronizer {
  handle: DocHandle<unknown>

  // track this separately from syncStates because you might have more syncStates than active peers
  peers: string[] = []
  syncStates: { [peerId: string]: Automerge.SyncState } = {} // peer -> syncState

  constructor(handle: DocHandle<unknown>) {
    super()
    this.handle = handle
    handle.on('change', () => this.syncWithPeers())
  }

  getSyncState(peerId: string) {
    if (!peerId) {
      throw new Error('Tried to load a missing peerId')
    }

    let syncState = this.syncStates[peerId]
    if (!syncState) {
      // TODO: load syncState from localStorage if available
      // console.log("adding a new peer", peerId)
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
    const doc = await this.handle.value()
    this.sendSyncMessage(peerId, documentId, doc)
  }

  endSync(peerId: string) {
    this.peers.filter(p => p !== peerId)
  }

  async onSyncMessage(peerId: string, message: Uint8Array) {
    this.handle.updateDoc((doc: unknown): unknown => {
      let syncState = this.getSyncState(peerId)
      // console.log("on sync message", peerId)
      ;[doc, syncState] = Automerge.receiveSyncMessage(doc, syncState, message)
      this.setSyncState(peerId, syncState)
      return doc
    })
  }

  async syncWithPeers() {
    // console.log("syncing with peers")
    const { documentId } = this.handle
    const doc = await this.handle.value()
    this.peers.forEach(peerId => {
      // console.log("messaging peer", peerId)
      this.sendSyncMessage(peerId, documentId, doc)
    })
  }
}
