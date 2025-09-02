import {
  DocumentPhasor,
  GenerateArgs,
  PeerState,
  Phase,
  PhaseName,
  PhaseTransition,
  ReceiveArgs,
} from "../DocumentPhasor.js"
import { DocMessage } from "../network/messages.js"
import { DocumentId, PeerId } from "../types.js"
import { next as Automerge } from "@automerge/automerge"

type PeerRequestState =
  | { state: "awaiting_send" }
  | { state: "not_requesting_due_to_sharepolicy" }
  | { state: "requesting" }
  | { state: "requested_from_us" }
  | { state: "unavailable" }
  | { state: "syncing"; theirHeads: Automerge.Heads }

type RequestStatus =
  | { state: "running"; peers: { [peerId: PeerId]: PeerRequestState } }
  | { state: "completed"; found: boolean }

export class Request implements Phase {
  name: PhaseName = "requesting"
  peerStates: Map<PeerId, PeerRequestState> = new Map()
  #ourPeerId: PeerId
  #documentId: DocumentId
  #log: debug.Debugger

  constructor(
    ourPeerId: PeerId,
    documentId: DocumentId,
    peers: Iterable<PeerState>,
    log: debug.Debugger
  ) {
    this.#ourPeerId = ourPeerId
    this.#documentId = documentId
    this.peerStates = new Map()
    for (const peer of peers) {
      this.peerStates.set(peer.peerId, { state: "awaiting_send" })
    }
    this.#log = log
  }

  addPeer(peerId: PeerId) {
    this.peerStates.set(peerId, { state: "awaiting_send" })
  }

  removePeer(peerId: PeerId) {
    this.peerStates.delete(peerId)
  }

  transition<T>(phasor: DocumentPhasor<T>): PhaseTransition | undefined {
    if (!phasor.networkReady()) {
      this.#log("request still waiting for network to be ready")
      return
    }
    const requestStatus = this.status(phasor.doc())
    this.#log("request status: ", requestStatus)
    if (requestStatus.state === "completed") {
      if (requestStatus.found) {
        return { to: "ready", pendingSyncMessages: new Map() }
      } else {
        const awaitingNotification = new Set(this.peersWaitingForOurResponse())
        return { to: "unavailable", awaitingNotification }
      }
    }
  }

  status(doc: Automerge.Doc<unknown>): RequestStatus {
    let allUnavailable = this.peerStates.values().every(peer => {
      return [
        "unavailable",
        "requested_from_us",
        "not_requesting_due_to_sharepolicy",
      ].includes(peer.state)
    })
    if (allUnavailable) {
      return { state: "completed", found: false }
    }

    let anySyncIsDone = this.peerStates.values().some(peer => {
      if (peer.state === "syncing") {
        return Automerge.hasHeads(doc, peer.theirHeads)
      } else {
        return false
      }
    })

    if (anySyncIsDone) {
      return { state: "completed", found: true }
    }

    const peers: { [peerId: PeerId]: PeerRequestState } = {}
    for (const [peerId, peerState] of this.peerStates) {
      peers[peerId] = peerState
    }
    return { state: "running", peers }
  }

  peersWaitingForOurResponse(): PeerId[] {
    return Array.from(this.peerStates.keys()).filter(peerId => {
      const peerState = this.peerStates.get(peerId)
      return peerState && peerState.state === "requested_from_us"
    })
  }

  sharePolicyChanged(peerId: PeerId) {}

  receiveMessage({
    doc,
    remotePeer,
    syncState,
    msg,
  }: ReceiveArgs):
    | { newDoc: Automerge.Doc<unknown>; newSyncState: Automerge.SyncState }
    | undefined {
    const peerState = this.peerStates.get(remotePeer)
    if (!peerState) {
      throw new Error("received message for unknown peer state")
    }
    this.#log(
      `request: received message from ${remotePeer} in state ${peerState.state}`
    )
    switch (msg.type) {
      case "request": {
        switch (peerState.state) {
          case "awaiting_send":
          case "requesting":
          case "requested_from_us":
          case "unavailable":
          case "not_requesting_due_to_sharepolicy":
          case "syncing": // weird, they must have lost their storage or something
            this.peerStates.set(remotePeer, { state: "requested_from_us" })
            break
          default:
            let exhaustivenessCheck: never = peerState
            throw new Error(`Unhandled peer state: ${exhaustivenessCheck}`)
        }
        const [newDoc, newSyncState] = Automerge.receiveSyncMessage(
          doc,
          syncState,
          msg.data
        )
        return { newDoc, newSyncState }
      }
      case "sync": {
        const decoded = Automerge.decodeSyncMessage(msg.data)
        if (peerState.state !== "syncing") {
          this.peerStates.set(remotePeer, {
            state: "syncing",
            theirHeads: decoded.heads,
          })
        }
        const [newDoc, newSyncState] = Automerge.receiveSyncMessage(
          doc,
          syncState,
          msg.data
        )
        return { newDoc, newSyncState }
      }
      case "doc-unavailable":
        this.peerStates.set(remotePeer, { state: "unavailable" })
        return
    }
  }

  generateMessage({
    doc,
    remotePeer,
    syncState,
    shouldShare,
  }: GenerateArgs):
    | { msg: DocMessage; newSyncState: Automerge.SyncState }
    | undefined {
    const peerState = this.peerStates.get(remotePeer)
    if (!peerState) {
      throw new Error("generating message for unknown peer state")
    }
    switch (peerState.state) {
      case "requested_from_us":
        return
      case "unavailable":
        return
      case "not_requesting_due_to_sharepolicy":
        if (shouldShare) {
          // This would happen if the sharePolicy changed since the last time we checked
          // somehow
          this.peerStates.set(remotePeer, {
            state: "awaiting_send",
          })
          return this.generateMessage({
            docId: this.#documentId,
            doc,
            remotePeer,
            syncState,
            shouldShare,
          })
        }
        return
      case "requesting":
        return
      case "awaiting_send": {
        if (!shouldShare) {
          this.peerStates.set(remotePeer, {
            state: "not_requesting_due_to_sharepolicy",
          })
          return
        }
        // If we're already syncing with another peer, don't send a request yet
        if (this.peerStates.values().some(s => s.state === "syncing")) {
          return
        }
        const [newSyncState, msg] = Automerge.generateSyncMessage(
          doc,
          syncState
        )
        if (!msg) {
          this.peerStates.set(remotePeer, { state: "unavailable" })
          return
        } else {
          this.peerStates.set(remotePeer, { state: "requesting" })
        }
        return {
          newSyncState,
          msg: {
            type: "request",
            senderId: this.#ourPeerId,
            targetId: remotePeer,
            data: msg,
            documentId: this.#documentId,
          },
        }
      }
      case "syncing": {
        const [newSyncState, syncMsg] = Automerge.generateSyncMessage(
          doc,
          syncState
        )
        if (!syncMsg) {
          return
        }
        return {
          newSyncState,
          msg: {
            type: "sync",
            senderId: this.#ourPeerId,
            targetId: remotePeer,
            data: syncMsg,
            documentId: this.#documentId,
          },
        }
      }
      default:
        const exhaustivenessCheck: never = peerState
        throw new Error(`Unhandled peer request state: ${exhaustivenessCheck}`)
    }
    return
  }
}
