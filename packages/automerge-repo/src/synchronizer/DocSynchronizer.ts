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
import { DocumentId, PeerId } from "../types.js"
import { Synchronizer } from "./Synchronizer.js"
import { throttle } from "../helpers/throttle.js"

type PeerDocumentStatus = "unknown" | "has" | "unavailable" | "wants"

type PendingMessage = {
  message: RequestMessage | SyncMessage
  received: Date
}

interface DocSynchronizerConfig {
  handle: DocHandle<unknown>
  docId: DocumentId
  beelay: A.beelay.Beelay
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

  #peerDocumentStatuses: Record<PeerId, PeerDocumentStatus> = {}
  #lastSaveOffset: string | null = null
  #syncStarted = false
  #beelay: A.beelay.Beelay

  #handle: DocHandle<unknown>
  #docId: DocumentId

  constructor({ handle, docId, beelay }: DocSynchronizerConfig) {
    super()
    this.#handle = handle
    this.#beelay = beelay
    this.#docId = docId

    this.#log = debug(`automerge-repo:docsync:${docId}`)

    if (handle != null) {
      handle.on("ephemeral-message-outbound", payload =>
        this.#broadcastToPeers(payload)
      )
    }
  }

  get peerStates() {
    return this.#peerDocumentStatuses
  }

  get documentId(): DocumentId {
    return this.#docId
  }

  /// PRIVATE

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
      documentId: this.documentId,
      data,
    }
    this.emit("message", message)
  }

  #addPeer(peerId: PeerId) {
    if (!this.#peers.includes(peerId)) {
      this.#peers.push(peerId)
      this.emit("open-doc", { documentId: this.documentId, peerId })
    }
  }

  /// PUBLIC

  hasPeer(peerId: PeerId) {
    return this.#peers.includes(peerId)
  }

  beginSync(peerIds: PeerId[]) {
    this.#log(`beginSync: ${peerIds.join(", ")}`)

    const docPromise = this.#handle
      .whenReady([READY, REQUESTING, UNAVAILABLE])
      .then(doc => {
        this.#syncStarted = true
        this.#checkDocUnavailable()
      })

    peerIds.forEach(peerId => {
      if (!this.#peers.includes(peerId)) {
        this.#peers.push(peerId)
      } else {
        return
      }
      this.#peerDocumentStatuses[peerId] = "unknown"

      docPromise.then(() => {
        this.#syncStarted = true
        this.#log(`beginning sync with ${peerId} for doc: ${this.documentId}`)
        this.#beelay
          .syncDoc(this.documentId, peerId)
          .then(({ snapshot, found }) => {
            this.#peerDocumentStatuses[peerId] = found ? "has" : "unavailable"
            // this.#log("synced snapshot: ", snapshot)
            if (found) {
              this.#beelay.loadDocument(this.#docId).then(commitOrBundles => {
                if (commitOrBundles != null) {
                  this.#handle?.update(d => {
                    let doc = d
                    for (const commitOrBundle of commitOrBundles) {
                      doc = A.loadIncremental(doc, commitOrBundle.contents)
                    }
                    return doc
                  })
                  this.#checkDocUnavailable()
                }
              })
            } else {
              this.#checkDocUnavailable()
            }
            this.#beelay.listen(peerId, snapshot)
          })
      })
    })
  }

  peerWantsDocument(peerId: PeerId) {
    this.#peerDocumentStatuses[peerId] = "wants"
    if (!this.#peers.includes(peerId)) {
      this.beginSync([peerId as PeerId])
    }
  }

  endSync(peerId: PeerId) {
    this.#log(`removing peer ${peerId}`)
    this.#peers = this.#peers.filter(p => p !== peerId)
    this.#beelay.cancelListens(peerId)
  }

  receiveMessage(message: RepoMessage) {
    switch (message.type) {
      case "sync":
      case "request":
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
    if (message.documentId !== this.documentId)
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

  receiveSyncMessage(message: SyncMessage | RequestMessage) {}

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
            documentId: this.documentId,
            targetId: peerId,
          }
          this.emit("message", message)
        })

      if (this.#handle) {
        this.#handle.unavailable()
      }
    }
  }

  metrics(): {
    peers: PeerId[]
    size: { numOps: number; numChanges: number } | undefined
  } {
    return {
      peers: this.#peers,
      size: this.#handle?.metrics(),
    }
  }
}
