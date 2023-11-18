import { EventEmitter } from "eventemitter3"
import {PeerId} from "../types.js"
import { next as A } from "@automerge/automerge"

type DocPeerConnectionEvent =
  { "type": "message", "msg": A.SyncMessage }

export class DocPeerConnection extends EventEmitter<DocPeerConnectionEvent> {
  #state: State = { "type": "loading-sync-state", pendingMessages: [] }

  constructor(private readonly peer: PeerId) {
    super()
  }

  receiveSyncMessage(doc: A.Doc<unknown>, msg: A.SyncMessage) {
  }

  setSyncState(syncState: A.SyncState, doc: A.Doc<unknown>): A.Doc<unknown> {
    let pendingMessages: A.SyncMessage[] = []
    if (this.#state.type === "loading-sync-state") {
      pendingMessages = this.#state.pendingMessages
    }
    let newSyncState = syncState
    for (const msg of pendingMessages) {
      [newSyncState, doc] = A.receiveSyncMessage(doc, newSyncState, msg)
    }
    this.#state = { "type": "ready", syncState: newSyncState }
    return doc
  }
}


type State = 
  { "type": "loading-sync-state", pendingMessages: A.SyncMessage[]}
| { "type": "ready", "syncState": A.SyncState }


