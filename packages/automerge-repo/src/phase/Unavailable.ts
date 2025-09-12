import {
  DocumentPhasor,
  GenerateArgs,
  Phase,
  PhaseName,
  PhaseTransition,
  ReceiveArgs,
} from "../DocumentPhasor.js"
import { DocMessage, MessageContents } from "../network/messages.js"
import { PeerId } from "../types.js"
import { next as Automerge } from "@automerge/automerge"

export class Unavailable implements Phase {
  name: PhaseName = "unavailable"
  awaitingNotification: Set<PeerId>
  receivedSyncMessages: Map<PeerId, DocMessage[]> = new Map()
  peerAdded: boolean = false

  constructor(awaitingNotification: Set<PeerId>) {
    this.awaitingNotification = awaitingNotification
  }

  addPeer(peerId: PeerId) {
    this.peerAdded = true
  }
  removePeer(peerId: PeerId) {}

  transition<T>(phasor: DocumentPhasor<T>): PhaseTransition | undefined {
    if (this.receivedSyncMessages.size > 0) {
      return { to: "ready", pendingSyncMessages: this.receivedSyncMessages }
    }
    if (this.peerAdded || phasor.loadRunning()) {
      return { to: "loading", pendingSyncMessages: new Map() }
    }
  }

  generateMessage({
    remotePeer,
    docId,
    syncState,
  }: GenerateArgs):
    | { newSyncState: Automerge.SyncState; msg: MessageContents }
    | undefined {
    if (this.awaitingNotification.has(remotePeer)) {
      this.awaitingNotification.delete(remotePeer)
      return {
        newSyncState: syncState,
        msg: {
          type: "doc-unavailable",
          targetId: remotePeer,
          documentId: docId,
        },
      }
    }
  }

  receiveMessage(args: ReceiveArgs):
    | {
        newSyncState: Automerge.SyncState
        newDoc: Automerge.Doc<unknown>
      }
    | undefined {
    const { remotePeer, syncState, msg } = args
    if (msg.type === "sync" || msg.type === "request") {
      let messages = this.receivedSyncMessages.get(remotePeer)
      if (messages == null) {
        messages = []
        this.receivedSyncMessages.set(remotePeer, messages)
      }
      messages.push(msg)
    }
    return
  }
}
