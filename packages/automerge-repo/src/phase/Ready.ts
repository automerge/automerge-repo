import {
  DocumentPhasor,
  GenerateArgs,
  Phase,
  PhaseName,
  PhaseTransition,
  ReceiveArgs,
} from "../DocumentPhasor.js"
import { MessageContents } from "../network/messages.js"
import { PeerId } from "../types.js"
import { next as Automerge } from "@automerge/automerge"

export class Ready implements Phase {
  name: PhaseName = "ready"
  addPeer(peerId: PeerId) {}
  removePeer(peerId: PeerId) {}

  transition<T>(phasor: DocumentPhasor<T>): PhaseTransition | undefined {
    return
  }

  generateMessage({
    doc,
    docId,
    syncState,
    remotePeer,
  }: GenerateArgs):
    | { newSyncState: Automerge.SyncState; msg: MessageContents }
    | undefined {
    const [newSyncState, msg] = Automerge.generateSyncMessage(doc, syncState)
    if (msg == null) return undefined
    return {
      newSyncState,
      msg: { type: "sync", data: msg, targetId: remotePeer, documentId: docId },
    }
  }
  receiveMessage({ msg, doc, syncState }: ReceiveArgs):
    | {
        newSyncState: Automerge.SyncState
        newDoc: Automerge.Doc<unknown>
      }
    | undefined {
    switch (msg.type) {
      case "request":
      case "sync":
        const [newDoc, newSyncState] = Automerge.receiveSyncMessage(
          doc,
          syncState,
          msg.data
        )
        return { newDoc, newSyncState }
      case "doc-unavailable":
        // wat
        break
      default:
        const exhaustiveCheck: never = msg
        throw new Error(`Unhandled message type: ${exhaustiveCheck}`)
    }
  }
}
