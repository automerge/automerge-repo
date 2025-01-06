import * as A from "@automerge/automerge/slim/next"
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
  MessageContents,
  RepoMessage,
  RequestMessage,
  SyncMessage,
  isRequestMessage,
} from "../network/messages.js"
import { PeerId } from "../types.js"
import { Synchronizer } from "./Synchronizer.js"
import { throttle } from "../helpers/throttle.js"

type PeerDocumentStatus = "unknown" | "has" | "unavailable" | "wants"

type PendingMessage = {
  message: RequestMessage | SyncMessage
  received: Date
}

interface DocSynchronizerConfig {
  handle: DocHandle<unknown>
  peerId: PeerId
  onLoadSyncState?: (peerId: PeerId) => Promise<A.SyncState | undefined>
}

/**
 * DocSynchronizer takes a handle to an Automerge document, and receives & dispatches sync messages
 * to bring it inline with all other peers' versions.
 */
export class DocSynchronizer extends Synchronizer {
  #log: debug.Debugger
  syncDebounceRate = 100

  /** Active peers */
  #peers: PeerId[] = []

  #pendingSyncStateCallbacks: Record<
    PeerId,
    ((syncState: A.SyncState) => void)[]
  > = {}

  #peerDocumentStatuses: Record<PeerId, PeerDocumentStatus> = {}

  /** Sync state for each peer we've communicated with (including inactive peers) */
  #syncStates: Record<PeerId, A.SyncState> = {}

  #pendingSyncMessages: Array<PendingMessage> = []

  #peerId: PeerId
  #syncStarted = false

  #handle: DocHandle<unknown>
  #onLoadSyncState: (peerId: PeerId) => Promise<A.SyncState | undefined>

  constructor({ handle, peerId, onLoadSyncState }: DocSynchronizerConfig) {
    super()
    this.#peerId = peerId
    this.#handle = handle
    this.#onLoadSyncState =
      onLoadSyncState ?? (() => Promise.resolve(undefined))

    const docId = handle.documentId.slice(0, 5)
    this.#log = debug(`automerge-repo:docsync:${docId}`)

    handle.on(
      "change",
      throttle(() => this.#syncWithPeers(), this.syncDebounceRate)
    )

    handle.on("ephemeral-message-outbound", payload =>
      this.#broadcastToPeers(payload)
    )

    // Process pending sync messages immediately after the handle becomes ready.
    void (async () => {
      await handle.whenReady([READY, REQUESTING])
      this.#processAllPendingSyncMessages()
    })()
  }

  get peerStates() {
    return this.#peerDocumentStatuses
  }

  get documentId() {
    return this.#handle.documentId
  }

  /// PRIVATE

  async #syncWithPeers() {
    const doc = await this.#handle.legacyAsyncDoc() // XXX THIS ONE IS WEIRD
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
      documentId: this.#handle.documentId,
      data,
    }
    this.emit("message", message)
  }

  #withSyncState(peerId: PeerId, callback: (syncState: A.SyncState) => void) {
    this.#addPeer(peerId)

    if (!(peerId in this.#peerDocumentStatuses)) {
      this.#peerDocumentStatuses[peerId] = "unknown"
    }

    const syncState = this.#syncStates[peerId]
    if (syncState) {
      callback(syncState)
      return
    }

    let pendingCallbacks = this.#pendingSyncStateCallbacks[peerId]
    if (!pendingCallbacks) {
      this.#onLoadSyncState(peerId)
        .then(syncState => {
          this.#initSyncState(peerId, syncState ?? A.initSyncState())
        })
        .catch(err => {
          this.#log(`Error loading sync state for ${peerId}: ${err}`)
        })
      pendingCallbacks = this.#pendingSyncStateCallbacks[peerId] = []
    }

    pendingCallbacks.push(callback)
  }

  #addPeer(peerId: PeerId) {
    if (!this.#peers.includes(peerId)) {
      this.#peers.push(peerId)
      this.emit("open-doc", { documentId: this.documentId, peerId })
    }
  }

  #initSyncState(peerId: PeerId, syncState: A.SyncState) {
    const pendingCallbacks = this.#pendingSyncStateCallbacks[peerId]
    if (pendingCallbacks) {
      for (const callback of pendingCallbacks) {
        callback(syncState)
      }
    }

    delete this.#pendingSyncStateCallbacks[peerId]

    this.#syncStates[peerId] = syncState
  }

  #setSyncState(peerId: PeerId, syncState: A.SyncState) {
    this.#syncStates[peerId] = syncState

    this.emit("sync-state", {
      peerId,
      syncState,
      documentId: this.#handle.documentId,
    })
  }

  #sendSyncMessage(peerId: PeerId, doc: A.Doc<unknown>) {
    this.#log(`sendSyncMessage ->${peerId}`)

    this.#withSyncState(peerId, syncState => {
      const [newSyncState, message] = A.generateSyncMessage(doc, syncState)
      if (message) {
        this.#setSyncState(peerId, newSyncState)
        const isNew = A.getHeads(doc).length === 0

        if (
          !this.#handle.isReady() &&
          isNew &&
          newSyncState.sharedHeads.length === 0 &&
          !Object.values(this.#peerDocumentStatuses).includes("has") &&
          this.#peerDocumentStatuses[peerId] === "unknown"
        ) {
          // we don't have the document (or access to it), so we request it
          this.emit("message", {
            type: "request",
            targetId: peerId,
            documentId: this.#handle.documentId,
            data: message,
          } as RequestMessage)
        } else {
          this.emit("message", {
            type: "sync",
            targetId: peerId,
            data: message,
            documentId: this.#handle.documentId,
          } as SyncMessage)
        }

        // if we have sent heads, then the peer now has or will have the document
        if (!isNew) {
          this.#peerDocumentStatuses[peerId] = "has"
        }
      }
    })
  }

  /// PUBLIC

  hasPeer(peerId: PeerId) {
    return this.#peers.includes(peerId)
  }

  async beginSync(peerIds: PeerId[]) {
    const noPeersWithDocument = peerIds.every(
      peerId => this.#peerDocumentStatuses[peerId] in ["unavailable", "wants"]
    )

    // At this point if we don't have anything in our storage, we need to use an empty doc to sync
    // with; but we don't want to surface that state to the front end
    const docPromise = this.#handle // TODO THIS IS ALSO WEIRD
      .legacyAsyncDoc([READY, REQUESTING, UNAVAILABLE])
      .then(doc => {
        // we register out peers first, then say that sync has started
        this.#syncStarted = true
        this.#checkDocUnavailable()

        const wasUnavailable = doc === undefined
        if (wasUnavailable && noPeersWithDocument) {
          return
        }

        // If the doc is unavailable we still need a blank document to generate
        // the sync message from
        return doc ?? A.init<unknown>()
      })

    const peersWithDocument = this.#peers.some(peerId => {
      return this.#peerDocumentStatuses[peerId] == "has"
    })

    if (peersWithDocument) {
      await this.#handle.whenReady()
    }

    peerIds.forEach(peerId => {
      this.#withSyncState(peerId, syncState => {
        // HACK: if we have a sync state already, we round-trip it through the encoding system to make
        // sure state is preserved. This prevents an infinite loop caused by failed attempts to send
        // messages during disconnection.
        // TODO: cover that case with a test and remove this hack
        const reparsedSyncState = A.decodeSyncState(
          A.encodeSyncState(syncState)
        )
        this.#setSyncState(peerId, reparsedSyncState)

        docPromise
          .then(doc => {
            if (doc) {
              this.#sendSyncMessage(peerId, doc)
            }
          })
          .catch(err => {
            this.#log(`Error loading doc for ${peerId}: ${err}`)
          })
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
    if (message.documentId !== this.#handle.documentId)
      throw new Error(`channelId doesn't match documentId`)

    const { senderId, data } = message

    const contents = decode(new Uint8Array(data))

    this.#handle.emit("ephemeral-message", {
      handle: this.#handle,
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
    if (message.documentId !== this.#handle.documentId)
      throw new Error(`channelId doesn't match documentId`)

    // We need to block receiving the syncMessages until we've checked local storage
    if (!this.#handle.inState([READY, REQUESTING, UNAVAILABLE])) {
      this.#pendingSyncMessages.push({ message, received: new Date() })
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

    this.#withSyncState(message.senderId, syncState => {
      this.#handle.update(doc => {
        const start = performance.now()

        const [newDoc, newSyncState] = A.receiveSyncMessage(
          doc,
          syncState,
          message.data
        )
        const end = performance.now()
        this.emit("metrics", {
          type: "receive-sync-message",
          documentId: this.#handle.documentId,
          durationMillis: end - start,
          ...A.stats(doc),
        })

        this.#setSyncState(message.senderId, newSyncState)

        // respond to just this peer (as required)
        this.#sendSyncMessage(message.senderId, doc)
        return newDoc
      })

      this.#checkDocUnavailable()
    })
  }

  #checkDocUnavailable() {
    // if we know none of the peers have the document, tell all our peers that we don't either
    if (
      this.#syncStarted &&
      this.#handle.inState([REQUESTING]) &&
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
            documentId: this.#handle.documentId,
            targetId: peerId,
          }
          this.emit("message", message)
        })

      this.#handle.unavailable()
    }
  }

  #processAllPendingSyncMessages() {
    for (const message of this.#pendingSyncMessages) {
      this.#processSyncMessage(message.message)
    }

    this.#pendingSyncMessages = []
  }

  metrics(): { peers: PeerId[]; size: { numOps: number; numChanges: number } } {
    return {
      peers: this.#peers,
      size: this.#handle.metrics(),
    }
  }
}
