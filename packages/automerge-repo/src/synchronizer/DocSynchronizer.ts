import * as A from "@automerge/automerge"
import {
  DocHandle,
  DocHandleOutboundEphemeralMessagePayload,
  READY,
  REQUESTING,
} from "../DocHandle.js"
import { PeerId } from "../types.js"
import { Synchronizer } from "./Synchronizer.js"

import debug from "debug"
import { EphemeralMessage, Message, SyncMessage } from "../network/messages.js"
import { decode } from "cbor-x"
import { receiveMessageServer } from "../../../automerge-repo-network-websocket/dist/WSShared"

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

  #pendingSyncMessages: Array<SyncMessage> = []

  constructor(private handle: DocHandle<any>) {
    super()
    const docId = handle.documentId.slice(0, 5)
    this.#conciseLog = debug(`automerge-repo:concise:docsync:${docId}`) // Only logs one line per receive/send
    this.#log = debug(`automerge-repo:docsync:${docId}`)
    this.#opsLog = debug(`automerge-repo:ops:docsync:${docId}`) // Log list of ops of each message

    handle.on("change", () => this.#syncWithPeers())

    handle.on("ephemeral-message-outbound", payload =>
      this.#broadcastToPeers(payload)
    )

    // Process pending sync messages immediately after the handle becomes ready.
    void (async () => {
      await handle.doc([READY, REQUESTING])
      this.#processAllPendingSyncMessages()
    })()
  }

  get documentId() {
    return this.handle.documentId
  }

  /// PRIVATE

  async #syncWithPeers() {
    this.#log(`syncWithPeers`)
    const doc = await this.handle.doc()
    this.#peers.forEach(peerId => this.#sendSyncMessage(peerId, doc))
  }

  async #broadcastToPeers({ data }: DocHandleOutboundEphemeralMessagePayload) {
    this.#log(`broadcastToPeers`, this.#peers)
    this.#peers.forEach(peerId => this.#sendEphemeralMessage(peerId, data))
  }

  #sendEphemeralMessage(peerId: PeerId, data: Uint8Array) {
    this.#log(`sendEphemeralMessage ->${peerId}`)

    this.emit("message", {
      type: "ephemeral",
      targetId: peerId,
      documentId: this.handle.documentId,
      data,
    })
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

      this.emit("message", {
        type: "sync",
        targetId: peerId,
        data: message,
        documentId: this.handle.documentId,
      })
    } else {
      this.#log(`sendSyncMessage ->${peerId} [no message generated]`)
    }
  }

  #logMessage = (label: string, message: Uint8Array) => {
    // This is real expensive...
    return

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

  beginSync(peerId: PeerId) {
    this.#log(`beginSync: ${peerId}`)

    // At this point if we don't have anything in our storage, we need to use an empty doc to sync
    // with; but we don't want to surface that state to the front end
    void this.handle.doc([READY, REQUESTING]).then(doc => {
      // HACK: if we have a sync state already, we round-trip it through the encoding system to make
      // sure state is preserved. This prevents an infinite loop caused by failed attempts to send
      // messages during disconnection.
      // TODO: cover that case with a test and remove this hack
      const syncStateRaw = this.#getSyncState(peerId)
      const syncState = A.decodeSyncState(A.encodeSyncState(syncStateRaw))
      this.#setSyncState(peerId, syncState)

      this.#sendSyncMessage(peerId, doc)
    })
  }

  endSync(peerId: PeerId) {
    this.#log(`removing peer ${peerId}`)
    this.#peers = this.#peers.filter(p => p !== peerId)
  }

  receiveMessage(message: Message) {
    switch (message.type) {
      case "sync":
        this.receiveSyncMessage(message)
        break
      case "ephemeral":
        this.receiveEphemeralMessage(message)
        break
      default:
        throw new Error(`unknown message type: ${message}`)
    }
  }

  receiveEphemeralMessage(message: EphemeralMessage) {
    if (message.documentId !== this.handle.documentId)
      throw new Error(`channelId doesn't match documentId`)

    const { senderId, data } = message

    const contents = decode(message.data)

    this.handle.emit("ephemeral-message", {
      handle: this.handle,
      senderId,
      message: contents,
    })
  }

  receiveSyncMessage(message: SyncMessage) {
    if (message.documentId !== this.handle.documentId)
      throw new Error(`channelId doesn't match documentId`)

    // We need to block receiving the syncMessages until we've checked local storage
    if (!this.handle.inState([READY, REQUESTING])) {
      this.#pendingSyncMessages.push(message)
      return
    }

    this.#processAllPendingSyncMessages()
    this.#processSyncMessage(message)
  }

  #processSyncMessage(message: SyncMessage) {
    this.handle.update(doc => {
      const [newDoc, newSyncState] = A.receiveSyncMessage(
        doc,
        this.#getSyncState(message.senderId),
        message.data
      )

      this.#setSyncState(message.senderId, newSyncState)

      // respond to just this peer (as required)
      this.#sendSyncMessage(message.senderId, doc)
      return newDoc
    })
  }

  #processAllPendingSyncMessages() {
    for (const message of this.#pendingSyncMessages) {
      this.#processSyncMessage(message)
    }

    this.#pendingSyncMessages = []
  }
}
