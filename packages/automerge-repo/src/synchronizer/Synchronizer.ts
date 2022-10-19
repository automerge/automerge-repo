import EventEmitter from "eventemitter3"
import { DocumentId } from "../DocHandle"
import { PeerId } from "../network/NetworkSubsystem"

export interface SyncMessageArg {
  peerId: PeerId
  documentId: DocumentId
  message: Uint8Array
}

export interface SyncMessages {
  message: (arg: SyncMessageArg) => void
}

export interface Synchronizer extends EventEmitter<SyncMessages> {
  onSyncMessage(peerId: PeerId, message: Uint8Array): void
}
