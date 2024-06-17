import { EventEmitter } from "eventemitter3"
import {
  MessageContents,
  OpenDocMessage,
  RepoMessage,
} from "../network/messages.js"
import { SyncState } from "@automerge/automerge/slim"
import { PeerId, DocumentId } from "../types.js"

export abstract class Synchronizer extends EventEmitter<SynchronizerEvents> {
  abstract receiveMessage(message: RepoMessage): void
}

export interface SynchronizerEvents {
  message: (payload: MessageContents) => void
  "sync-state": (payload: SyncStatePayload) => void
  "open-doc": (arg: OpenDocMessage) => void
}

/** Notify the repo that the sync state has changed  */
export interface SyncStatePayload {
  peerId: PeerId
  documentId: DocumentId
  syncState: SyncState
}
