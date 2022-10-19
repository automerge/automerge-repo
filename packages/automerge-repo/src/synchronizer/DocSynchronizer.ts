import EventEmitter from "eventemitter3"
import { Synchronizer, SyncMessages } from "./Synchronizer"
import * as Automerge from "@automerge/automerge"
import { DocHandle } from "../DocHandle"

/**
 * DocSynchronizer takes a handle to an Automerge document, and receives & dispatches sync messages
 * to bring it inline with all other peers' versions.
 */
export class DocSynchronizer
  extends EventEmitter<SyncMessages>
  implements Synchronizer
{
  handle: DocHandle<unknown>

  // we track peers separately from syncStates because we might have more syncStates than active peers
  peers: string[] = []
  syncStates: { [peerId: string]: Automerge.SyncState } = {} // peer -> syncState

  constructor(handle: DocHandle<unknown>) {
    super()
    this.handle = handle
    handle.on("change", () => this.syncWithPeers())
  }

  getSyncState(peerId: string) {
    if (!peerId) {
      throw new Error("Tried to load a missing peerId")
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

  async sendSyncMessage(
    peerId: string,
    documentId: string,
    doc: Automerge.Doc<unknown>
  ) {
    console.log(`[${this.handle.documentId}]->[${peerId}]: sendSyncMessage`)
    const syncState = this.getSyncState(peerId)
    const [newSyncState, message] = Automerge.generateSyncMessage(
      doc,
      syncState
    )
    this.setSyncState(peerId, newSyncState)
    if (message) {
      console.log(
        `[${this.handle.documentId}]->[${peerId}]: sendSyncMessage: ${message.byteLength}b`
      )
      this.emit("message", { peerId, documentId, message })
    } else {
      console.log(
        `[${this.handle.documentId}]->[${peerId}]: sendSyncMessage: [no message generated]`
      )
    }
  }

  async beginSync(peerId: string) {
    console.log(`[${this.handle.documentId}]: beginSync: ${peerId}`)
    const { documentId } = this.handle
    const doc = await this.handle.syncValue()
    this.sendSyncMessage(peerId, documentId, doc)
  }

  endSync(peerId: string) {
    this.peers.filter((p) => p !== peerId)
  }

  async onSyncMessage(peerId: string, message: Uint8Array) {
    this.handle.updateDoc((doc) => {
      console.log(
        `[${this.handle.documentId}]: receiveSync: ${message.byteLength}b from ${peerId}`
      )
      const [newDoc, newSyncState] = Automerge.receiveSyncMessage(
        doc,
        this.getSyncState(peerId),
        message
      )
      this.setSyncState(peerId, newSyncState)
      return newDoc
    })
  }

  async syncWithPeers() {
    console.log(`[${this.handle.documentId}]: syncWithPeers`)
    const { documentId } = this.handle
    const doc = await this.handle.syncValue()
    this.peers.forEach((peerId) => {
      this.sendSyncMessage(peerId, documentId, doc)
    })
  }
}
