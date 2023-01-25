import * as A from "@automerge/automerge"
import debug from "debug"

import { DocHandle, PROVISIONAL } from "../DocHandle.js"
import { ChannelId, PeerId } from "../types.js"
import { Synchronizer } from "./Synchronizer.js"

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

  constructor(private handle: DocHandle) {
    super()

    this.#conciseLog = debug(`ar:concise:docsync:${this.documentId}`) // Only logs one line per receive/send
    this.#log = debug(`ar:docsync:${this.documentId}`)
    this.#opsLog = debug(`ar:ops:docsync:${this.documentId}`) // Log list of ops of each message

    handle.on("change", () => this.#syncWithPeers())
  }

  get documentId() {
    return this.handle.documentId
  }

  /// PRIVATE

  async #syncWithPeers() {
    this.#log(`syncWithPeers`)
    const doc = await this.handle.value(PROVISIONAL)
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

    const state = this.#getSyncState(peerId)
    const [newState, message] = A.generateSyncMessage(doc, state)
    this.#setSyncState(peerId, newState)

    // message will be null if there's nothing further to send
    if (message) {
      this.#logMessage(`sendSyncMessage sending 🡒 ${peerId}`, message)

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
    if (!message || message.byteLength === 0) return
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

  /** Returns true if we're already synchronizing with the given peer on this doc */
  hasPeer(peerId: PeerId) {
    return this.#peers.includes(peerId)
  }

  /** Kicks off the sync process */
  async beginSync(peerId: PeerId) {
    this.#log(`beginSync: ${peerId}`)
    const doc = await this.handle.value(PROVISIONAL)

    // Q: I don't totally understand why this business is necessary -- tests pass without it
    {
      // HACK: if we have a sync state already, we round-trip it through the encoding system to make
      // sure state is preserved (??). This prevents an infinite loop caused by failed attempts to send
      // messages during disconnection.
      const syncStateRaw = this.#getSyncState(peerId)
      const syncState = A.decodeSyncState(A.encodeSyncState(syncStateRaw))
      this.#setSyncState(peerId, syncState)
    }

    this.#sendSyncMessage(peerId, doc)
  }

  endSync(peerId: PeerId) {
    this.#log(`removing peer ${peerId}`)
    this.#peers = this.#peers.filter(p => p !== peerId)
  }

  /**
   * When we receive a sync message from a peer, we run it through Automerge's sync algorithm to
   */
  receiveSyncMessage(
    peerId: PeerId,
    channelId: ChannelId,
    message: Uint8Array
  ) {
    if (!message || message.byteLength === 0) return

    if ((channelId as string) !== (this.documentId as string))
      throw new Error(`channelId doesn't match documentId`)

    this.#logMessage(`onSyncMessage receiving 🡐 ${peerId}`, message)

    this.handle.updateDoc(doc => {
      const state = this.#getSyncState(peerId)

      const [newDoc, newState] = A.receiveSyncMessage(doc, state, message)

      this.#setSyncState(peerId, newState)

      // respond to just this peer (if needed)
      this.#sendSyncMessage(peerId, doc)
      return newDoc
    })
  }
}
