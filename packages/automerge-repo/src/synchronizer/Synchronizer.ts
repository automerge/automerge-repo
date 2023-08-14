import EventEmitter from "eventemitter3"
import { SyncMessage } from "../network/messages.js"

export abstract class Synchronizer extends EventEmitter<SynchronizerEvents> {
  abstract receiveSyncMessage(message: SyncMessage): void
}

export interface SynchronizerEvents {
  message: (arg: Omit<SyncMessage, "senderId">) => void
}
