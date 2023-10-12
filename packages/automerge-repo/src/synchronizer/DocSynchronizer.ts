import * as A from "@automerge/automerge/next"
import { decode } from "cbor-x"
import debug from "debug"
import {
  DocHandle,
  DocHandleOutboundEphemeralMessagePayload,
  READY,
  REQUESTING,
  UNAVAILABLE,
} from "../DocHandle.js"
import {
  DocumentUnavailableMessage,
  EphemeralMessage,
  RepoMessage,
  MessageContents,
  RequestMessage,
  SyncMessage,
  isRequestMessage,
} from "../network/messages.js"
import { PeerId } from "../types.js"
import { Synchronizer } from "./Synchronizer.js"

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

  #pendingSyncMessages: Array<SyncMessage | RequestMessage> = []

  #syncStarted = false

  constructor(private handle: DocHandle<unknown>) {
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

  async #broadcastToPeers({
    data,
  }: DocHandleOutboundEphemeralMessagePayload<unknown>) {
    this.#log(`broadcastToPeers`, this.#peers)
    this.#peers.forEach(peerId => this.#sendEphemeralMessage(peerId, data))
  }

  #sendEphemeralMessage(peerId: PeerId, data: Uint8Array) {
    this.#log(`sendEphemeralMessage ->${peerId}`)

    const message: MessageContents<EphemeralMessage> = {
      type: "ephemeral",
      targetId: peerId,
      documentId: this.handle.documentId,
      data,
    }
    this.emit("message", message)
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
      const isNew = A.getHeads(doc).length === 0

      if (
        !this.handle.isReady() &&
        isNew &&
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
        } as RequestMessage)
      } else {
        this.emit("message", {
          type: "sync",
          targetId: peerId,
          data: message,
          documentId: this.handle.documentId,
        } as SyncMessage)
      }

      // if we have sent heads, then the peer now has or will have the document
      if (!isNew) {
        this.#peerDocumentStatuses[peerId] = "has"
      }
    }
  }

  /// PUBLIC

  hasPeer(peerId: PeerId) {
    return this.#peers.includes(peerId)
  }

  beginSync(peerIds: PeerId[]) {
    this.#log(`beginSync: ${peerIds.join(", ")}`)

    // HACK: if we have a sync state already, we round-trip it through the encoding system to make
    // sure state is preserved. This prevents an infinite loop caused by failed attempts to send
    // messages during disconnection.
    // TODO: cover that case with a test and remove this hack
    peerIds.forEach(peerId => {
      const syncStateRaw = this.#getSyncState(peerId)
      const syncState = A.decodeSyncState(A.encodeSyncState(syncStateRaw))
      this.#setSyncState(peerId, syncState)
    })

    // At this point if we don't have anything in our storage, we need to use an empty doc to sync
    // with; but we don't want to surface that state to the front end
    void this.handle.doc([READY, REQUESTING, UNAVAILABLE]).then(doc => {
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

  receiveMessage(message: RepoMessage) {
    switch (message.type) {
      case "sync":
      case "request":
        this.receiveSyncMessage(message)
        break
      case "ephemeral":
        this.receiveEphemeralMessage(message)
        break
      case "doc-unavailable":
        this.#peerDocumentStatuses[message.senderId] = "unavailable"
        this.#checkDocUnavailable()
        break
      default:
        throw new Error(`unknown message type: ${message}`)
    }
  }

  receiveEphemeralMessage(message: EphemeralMessage) {
    if (message.documentId !== this.handle.documentId)
      throw new Error(`channelId doesn't match documentId`)

    const { senderId, data } = message

    const contents = decode(new Uint8Array(data))

    this.handle.emit("ephemeral-message", {
      handle: this.handle,
      senderId,
      message: contents,
    })

    this.#peers.forEach(peerId => {
      if (peerId === senderId) return
      this.emit("message", {
        ...message,
        targetId: peerId,
      })
    })
  }

  receiveSyncMessage(message: SyncMessage | RequestMessage) {
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

  #processSyncMessage(message: SyncMessage | RequestMessage) {
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
          const message: MessageContents<DocumentUnavailableMessage> = {
            type: "doc-unavailable",
            documentId: this.handle.documentId,
            targetId: peerId,
          }
          this.emit("message", message)
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
