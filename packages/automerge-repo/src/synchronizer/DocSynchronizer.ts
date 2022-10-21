import EventEmitter from "eventemitter3"
import { Synchronizer, SyncMessages } from "./Synchronizer"
import * as Automerge from "@automerge/automerge"
import { DocHandle, DocumentId } from "../DocHandle"
import { PeerId } from "../network/NetworkSubsystem"

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
  peers: PeerId[] = []
  syncStates: { [peerId: PeerId]: Automerge.SyncState } = {} // peer -> syncState

  constructor(handle: DocHandle<unknown>) {
    super()
    this.handle = handle
    handle.on("change", () => this.syncWithPeers())
  }

  getSyncState(peerId: PeerId) {
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

  setSyncState(peerId: PeerId, syncState: Automerge.SyncState) {
    this.syncStates[peerId] = syncState
  }

  async sendSyncMessage(
    peerId: PeerId,
    documentId: DocumentId,
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
      const decoded = Automerge.decodeSyncMessage(message)
      console.log(
        `[${this.handle.documentId}]->[${peerId}]: sendSyncMessage: ${message.byteLength}b`,
        decoded
      )
      this.emit("message", { peerId, documentId, message })
    } else {
      console.log(
        `[${this.handle.documentId}]->[${peerId}]: sendSyncMessage: [no message generated]`
      )
    }
  }

  async beginSync(peerId: PeerId) {
    console.log(`[${this.handle.documentId}]: beginSync: ${peerId}`)
    const { documentId } = this.handle
    const doc = await this.handle.syncValue()
    this.sendSyncMessage(peerId, documentId, doc)
  }

  endSync(peerId: PeerId) {
    this.peers.filter((p) => p !== peerId)
  }

  async onSyncMessage(peerId: PeerId, message: Uint8Array) {
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
    this.syncWithPeers()
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
