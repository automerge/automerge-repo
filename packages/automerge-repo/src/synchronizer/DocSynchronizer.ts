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
  #conciseLog: debug.Debugger
  #opsLog: debug.Debugger

  /** Active peers */
  #peers: PeerId[] = []

  /** Sync state for each peer we've communicated with (including inactive peers) */
  #syncStates: Record<PeerId, A.SyncState> = {}

  constructor(private handle: DocHandle<any>) {
    super()
    const docId = handle.documentId.slice(0, 5)
    this.#conciseLog = debug(`automerge-repo:concise:docsync:${docId}`) // Only logs one line per receive/send
    this.#log = debug(`automerge-repo:docsync:${docId}`)
    this.#opsLog = debug(`automerge-repo:ops:docsync:${docId}`) // Log list of ops of each message

    handle.on("change", () => this.#syncWithPeers())
  }

  get documentId() {
    return this.handle.documentId
  }

  /// PRIVATE

  async #syncWithPeers() {
    this.#log(`syncWithPeers`)
    const doc = await this.handle.provisionalValue()
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
    this.#log(`sendSyncMessage ->${peerId}`)

    const syncState = this.#getSyncState(peerId)
    const [newSyncState, message] = A.generateSyncMessage(doc, syncState)
    this.#setSyncState(peerId, newSyncState)
    if (message) {
      this.#logMessage(`sendSyncMessage 🡒 ${peerId}`, message)

      const channelId = this.handle.documentId as string as ChannelId
      this.emit("message", {
        targetId: peerId,
        channelId,
        message,
        broadcast: false,
      })
    } else {
      this.#log(`sendSyncMessage ->${peerId} [no message generated]`)
    }
  }

  #logMessage = (label: string, message: Uint8Array) => {
    const size = message.byteLength
    const logText = `${label} ${size}b`
    const decoded = A.decodeSyncMessage(message)

    this.#conciseLog(logText)
    this.#log(logText, decoded)

    // expanding is expensive, so only do it if we're logging at this level
    const expanded = this.#opsLog.enabled
      ? decoded.changes.flatMap(change =>
          A.decodeChange(change).ops.map(op => JSON.stringify(op))
        )
      : null
    this.#opsLog(logText, expanded)
  }

  /// PUBLIC

  hasPeer(peerId: PeerId) {
    return this.#peers.includes(peerId)
  }

  async beginSync(peerId: PeerId) {
    this.#log(`beginSync: ${peerId}`)
    const doc = await this.handle.provisionalValue()

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
    if ((channelId as string) !== (this.documentId as string))
      throw new Error(`channelId doesn't match documentId`)

    // We need to block receiving the syncMessages until we've checked local storage
    // TODO: this is kind of an opaque way of doing this...
    // await this.handle.provisionalValue()

    this.#logMessage(`onSyncMessage 🡐 ${peerId}`, message)

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
