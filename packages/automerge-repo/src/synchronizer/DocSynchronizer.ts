import EventEmitter from "eventemitter3"
import { Synchronizer, SyncMessages } from "./Synchronizer"
import * as Automerge from "@automerge/automerge"
import { DocHandle, DocumentId } from "../DocHandle"
import { ChannelId, PeerId } from "../network/NetworkSubsystem"
import debug from "debug"
const log = debug("DocSynchronizer")

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
      log("adding a new peer", peerId)
      if (!this.peers.includes(peerId)) {
        this.peers.push(peerId)
      }
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
    log(`[${this.handle.documentId}]->[${peerId}]: sendSyncMessage`)
    const syncState = this.getSyncState(peerId)
    const [newSyncState, message] = Automerge.generateSyncMessage(
      doc,
      syncState
    )
    this.setSyncState(peerId, newSyncState)
    if (message) {
      const decoded = Automerge.decodeSyncMessage(message)
      log(
        `[${this.handle.documentId}]->[${peerId}]: sendSyncMessage: ${message.byteLength}b`,
        decoded
      )

      const channelId = this.handle.documentId as unknown as ChannelId
      this.emit("message", {
        targetId: peerId,
        channelId,
        message,
        broadcast: false,
      })
    } else {
      log(
        `[${this.handle.documentId}]->[${peerId}]: sendSyncMessage: [no message generated]`
      )
    }
  }

  async beginSync(peerId: PeerId) {
    log(`[${this.handle.documentId}]: beginSync: ${peerId}`)
    const { documentId } = this.handle
    const doc = await this.handle.syncValue()

    // Just in case we have a sync state already, we round-trip it through
    // the encoding system to make sure state is preserved. This prevents an
    // infinite loop caused by failed attempts to send messages during disconnection.
    // TODO: we should be storing sync states and besides, we only need to do this on reconnect
    this.setSyncState(
      peerId,
      Automerge.decodeSyncState(
        Automerge.encodeSyncState(this.getSyncState(peerId))
      )
    )
    this.sendSyncMessage(peerId, documentId, doc)
  }

  endSync(peerId: PeerId) {
    this.peers.filter((p) => p !== peerId)
  }

  async onSyncMessage(
    peerId: PeerId,
    channelId: ChannelId,
    message: Uint8Array
  ) {
    if ((channelId as unknown as DocumentId) !== this.handle.documentId) {
      throw new Error(
        `[DocHandle: ${this.handle.documentId}]: Received a sync message for ${channelId}`
      )
    }
    this.handle.updateDoc((doc) => {
      const decoded = Automerge.decodeSyncMessage(message)
      log(
        `[${this.handle.documentId}]->[${peerId}]: receiveSync: ${message.byteLength}b`,
        decoded
      )

      const start = Date.now()
      const [newDoc, newSyncState] = Automerge.receiveSyncMessage(
        doc,
        this.getSyncState(peerId),
        message
      )
      const end = Date.now()
      const time = end - start
      log(
        `[${this.handle.documentId}]: receiveSync: <- ${peerId} ${
          message.byteLength
        }b in ${time}ms ${time > 1000 ? "[SLOW]!" : ""} from ${peerId}`
      )
      this.setSyncState(peerId, newSyncState)
      return newDoc
    })
    this.syncWithPeers()
  }

  async syncWithPeers() {
    log(`[${this.handle.documentId}]: syncWithPeers`)
    const { documentId } = this.handle
    const doc = await this.handle.syncValue()
    this.peers.forEach((peerId) => {
      this.sendSyncMessage(peerId, documentId, doc)
    })
  }
}
