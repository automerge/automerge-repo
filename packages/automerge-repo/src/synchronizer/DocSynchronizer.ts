import * as A from "@automerge/automerge"
import { DocHandle, READY, REQUESTING, UNAVAILABLE } from "../DocHandle.js"
import { PeerId } from "../types.js"
import { Synchronizer } from "./Synchronizer.js"

import debug from "debug"
import {
  isDocumentUnavailableMessage,
  isRequestMessage,
  SynchronizerMessage,
} from "../network/NetworkAdapter.js"

type PeerDocumentStatus = "unknown" | "has" | "unavailable" | "wants"

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

  #peerDocumentStatuses: Record<PeerId, PeerDocumentStatus> = {}

  /** Sync state for each peer we've communicated with (including inactive peers) */
  #syncStates: Record<PeerId, A.SyncState> = {}

  #pendingSyncMessages: Array<SynchronizerMessage> = []

  #syncStarted = false

  constructor(private handle: DocHandle<any>) {
    super()
    const docId = handle.documentId.slice(0, 5)
    this.#conciseLog = debug(`automerge-repo:concise:docsync:${docId}`) // Only logs one line per receive/send
    this.#log = debug(`automerge-repo:docsync:${docId}`)
    this.#opsLog = debug(`automerge-repo:ops:docsync:${docId}`) // Log list of ops of each message

    handle.on("change", () => this.#syncWithPeers())

    // Process pending sync messages immediately after the handle becomes ready.
    void (async () => {
      await handle.doc([READY, REQUESTING])
      this.#processAllPendingSyncMessages()
    })()
  }

  get peerStates() {
    return this.#peerDocumentStatuses
  }

  get documentId() {
    return this.handle.documentId
  }

  /// PRIVATE

  async #syncWithPeers() {
    this.#log(`syncWithPeers`)
    const doc = await this.handle.doc()
    if (doc === undefined) return
    this.#peers.forEach(peerId => this.#sendSyncMessage(peerId, doc))
  }

  #getSyncState(peerId: PeerId) {
    if (!this.#peers.includes(peerId)) {
      this.#log("adding a new peer", peerId)
      this.#peers.push(peerId)
    }

    // when a peer is added, we don't know if it has the document or not
    if (!(peerId in this.#peerDocumentStatuses)) {
      this.#peerDocumentStatuses[peerId] = "unknown"
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

      const decoded = A.decodeSyncMessage(message)

      if (
        !this.handle.isReady() &&
        decoded.heads.length === 0 &&
        newSyncState.sharedHeads.length === 0 &&
        !Object.values(this.#peerDocumentStatuses).includes("has") &&
        this.#peerDocumentStatuses[peerId] === "unknown"
      ) {
        // we don't have the document (or access to it), so we request it
        this.emit("message", {
          type: "request",
          targetId: peerId,
          documentId: this.handle.documentId,
          data: message,
        })
      } else {
        this.emit("message", {
          type: "sync",
          targetId: peerId,
          data: message,
          documentId: this.handle.documentId,
        })
      }

      // if we have sent heads, then the peer now has or will have the document
      if (decoded.heads.length > 0) {
        this.#peerDocumentStatuses[peerId] = "has"
      }
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

  beginSync(peerIds: PeerId[]) {
    this.#log(`beginSync: ${peerIds.join(", ")}`)

    // At this point if we don't have anything in our storage, we need to use an empty doc to sync
    // with; but we don't want to surface that state to the front end
    void this.handle.doc([READY, REQUESTING, UNAVAILABLE]).then(doc => {
      // if we don't have any peers, then we can say the document is unavailable

      // HACK: if we have a sync state already, we round-trip it through the encoding system to make
      // sure state is preserved. This prevents an infinite loop caused by failed attempts to send
      // messages during disconnection.
      // TODO: cover that case with a test and remove this hack
      peerIds.forEach(peerId => {
        const syncStateRaw = this.#getSyncState(peerId)
        const syncState = A.decodeSyncState(A.encodeSyncState(syncStateRaw))
        this.#setSyncState(peerId, syncState)
      })

      // we register out peers first, then say that sync has started
      this.#syncStarted = true
      this.#checkDocUnavailable()

      if (doc === undefined) return

      peerIds.forEach(peerId => {
        this.#sendSyncMessage(peerId, doc)
      })
    })
  }

  endSync(peerId: PeerId) {
    this.#log(`removing peer ${peerId}`)
    this.#peers = this.#peers.filter(p => p !== peerId)
  }

  receiveSyncMessage(message: SynchronizerMessage) {
    if (message.documentId !== this.handle.documentId)
      throw new Error(`channelId doesn't match documentId`)

    // We need to block receiving the syncMessages until we've checked local storage
    if (!this.handle.inState([READY, REQUESTING, UNAVAILABLE])) {
      this.#pendingSyncMessages.push(message)
      return
    }

    this.#processAllPendingSyncMessages()
    this.#processSyncMessage(message)
  }

  #processSyncMessage(message: SynchronizerMessage) {
    // if a peer is requesting the document, we know they don't have it
    if (isDocumentUnavailableMessage(message)) {
      this.#peerDocumentStatuses[message.senderId] = "unavailable"
      this.#checkDocUnavailable()
      return
    }

    if (isRequestMessage(message)) {
      this.#peerDocumentStatuses[message.senderId] = "wants"
    }

    this.#checkDocUnavailable()

    // if the message has heads, then the peer has the document
    if (A.decodeSyncMessage(message.data).heads.length > 0) {
      this.#peerDocumentStatuses[message.senderId] = "has"
    }

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

    this.#checkDocUnavailable()
  }

  #checkDocUnavailable() {
    // if we know none of the peers have the document, tell all our peers that we don't either
    if (
      this.#syncStarted &&
      this.handle.inState([REQUESTING]) &&
      this.#peers.every(
        peerId =>
          this.#peerDocumentStatuses[peerId] === "unavailable" ||
          this.#peerDocumentStatuses[peerId] === "wants"
      )
    ) {
      this.#peers
        .filter(peerId => this.#peerDocumentStatuses[peerId] === "wants")
        .forEach(peerId => {
          this.emit("message", {
            type: "doc-unavailable",
            documentId: this.handle.documentId,
            targetId: peerId,
          })
        })

      this.handle.unavailable()
    }
  }

  #processAllPendingSyncMessages() {
    for (const message of this.#pendingSyncMessages) {
      this.#processSyncMessage(message)
    }

    this.#pendingSyncMessages = []
  }
}
