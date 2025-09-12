import {
  DocumentPhasor,
  GenerateArgs,
  Phase,
  PhaseName,
  PhaseTransition,
  ReceiveArgs,
} from "../DocumentPhasor.js"
import { DocMessage } from "../network/messages.js"
import { PeerId } from "../types.js"
import { next as Automerge } from "@automerge/automerge"

export class Loading implements Phase {
  name: PhaseName = "loading"
  pendingSyncMessages: Map<PeerId, DocMessage[]> = new Map()

  addPeer(peerId: PeerId) {}
  removePeer(peerId: PeerId) {}

  transition<T>(phasor: DocumentPhasor<T>): PhaseTransition | undefined {
    if (phasor.loadRunning()) return
    if (Automerge.getHeads(phasor.doc()).length > 0) {
      phasor.log()("data found, transitioning to ready")
      return { to: "ready", pendingSyncMessages: this.pendingSyncMessages }
    } else {
      phasor.log()("no data found, transitioning to requesting")
      return { to: "requesting", pendingSyncMessages: this.pendingSyncMessages }
    }
  }

  generateMessage(
    args: GenerateArgs
  ): { newSyncState: Automerge.SyncState; msg: DocMessage } | undefined {
    return
  }
  receiveMessage({ remotePeer, msg }: ReceiveArgs):
    | {
        newSyncState: Automerge.SyncState
        newDoc: Automerge.Doc<unknown>
      }
    | undefined {
    let pending = this.pendingSyncMessages.get(remotePeer)
    if (!pending) {
      pending = []
      this.pendingSyncMessages.set(remotePeer, pending)
    }
    pending.push(msg)
    return
  }
}
