import EventEmitter from "eventemitter3"
import { SyncMessage } from "../types.js"

export abstract class Synchronizer extends EventEmitter<SynchronizerEvents> {
  abstract receiveSyncMessage(message: SyncMessage): void
}

export interface SynchronizerEvents {
  message: (message: SyncMessageWithoutSenderId) => void
}

// the network subsystem will add the senderId
type SyncMessageWithoutSenderId = Omit<SyncMessage, "senderId">
