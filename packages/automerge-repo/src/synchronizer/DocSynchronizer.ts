import * as A from "@automerge/automerge"
import { DocHandle } from "../DocHandle.js"
import { ChannelId, PeerId } from "../types.js"
import { Synchronizer } from "./Synchronizer.js"

import debug from "debug"

/**
 * DocSynchronizer takes a handle to an Automerge document, and receives & dispatches sync messages
 * to bring it inline with all other peers' versions.
 */
export class DocSynchronizer extends Synchronizer {
  #log: debug.Debugger

  /** Active peers */
  #peers: PeerId[] = []

  /** Sync state for each peer we've communicated with (including inactive peers) */
  #syncStates: Record<PeerId, A.SyncState> = {}

  constructor(private handle: DocHandle<any>) {
    super()
    const docId = handle.documentId.slice(0, 5)
    this.#log = debug(`automerge-repo:docsync:${docId}`)

    handle.on("change", () => this.#syncWithPeers())
  }

  get documentId() {
    return this.handle.documentId
  }

  /// PRIVATE

  async #syncWithPeers() {
    this.#log(`syncWithPeers`)
    const doc = await this.handle.value()
    this.#peers.forEach(peerId => this.#sendSyncMessage(peerId, doc))
  }

  #getSyncState(peerId: PeerId) {
    if (!this.#peers.includes(peerId)) {
      this.#log("adding a new peer", peerId)
      this.#peers.push(peerId)
    }

    return this.#syncStates[peerId] ?? A.initSyncState()
  }

  #setSyncState(peerId: PeerId, syncState: A.SyncState) {
    // TODO: we maybe should be persisting sync states. But we want to be careful about how often we
    // do that, because it can generate a lot of disk activity.

    // TODO: we only need to do this on reconnect

    this.#syncStates[peerId] = syncState
  }

  #sendSyncMessage(peerId: PeerId, doc: A.Doc<unknown>) {
    const syncState = this.#getSyncState(peerId)
    const [newSyncState, message] = A.generateSyncMessage(doc, syncState)
    this.#setSyncState(peerId, newSyncState)
    if (message) {
      this.#log(`sendSyncMessage → ${peerId} ${message.byteLength}b`)
      const channelId = this.handle.documentId as string as ChannelId
      this.emit("message", {
        targetId: peerId,
        channelId,
        message,
        broadcast: false,
      })
    } else {
      this.#log(`sendSyncMessage → ${peerId} [no message generated]`)
    }
  }

  /// PUBLIC

  hasPeer(peerId: PeerId) {
    return this.#peers.includes(peerId)
  }

  async beginSync(peerId: PeerId) {
    this.#log(`beginSync: ${peerId}`)

    // to HERB: at this point if we don't have anything in our Storage
    //          we need to use an empty doc to sync with , but we don't
    //          want to surface that state to the frontend
    const doc = await this.handle.loadAttemptedValue()

    // HACK: if we have a sync state already, we round-trip it through the encoding system to make
    // sure state is preserved. This prevents an infinite loop caused by failed attempts to send
    // messages during disconnection.

    // TODO: cover that case with a test and remove this hack
    const syncStateRaw = this.#getSyncState(peerId)
    const syncState = A.decodeSyncState(A.encodeSyncState(syncStateRaw))
    this.#setSyncState(peerId, syncState)

    this.#sendSyncMessage(peerId, doc)
  }

  endSync(peerId: PeerId) {
    this.#log(`removing peer ${peerId}`)
    this.#peers = this.#peers.filter(p => p !== peerId)
  }

  async receiveSyncMessage(
    peerId: PeerId,
    channelId: ChannelId,
    message: Uint8Array
  ) {
    this.#log(`receiveSyncMessage ← ${peerId} ${message.byteLength}b`)

    if ((channelId as string) !== (this.documentId as string))
      throw new Error(`channelId doesn't match documentId`)

    // We need to block receiving the syncMessages until we've checked local storage
    // TODO: this is kind of an opaque way of doing this...
    await this.handle.loadAttemptedValue()

    this.handle.update(doc => {
      const [newDoc, newSyncState] = A.receiveSyncMessage(
        doc,
        this.#getSyncState(peerId),
        message
      )

      this.#setSyncState(peerId, newSyncState)

      // respond to just this peer (as required)
      this.#sendSyncMessage(peerId, doc)
      return newDoc
    })
  }
}
