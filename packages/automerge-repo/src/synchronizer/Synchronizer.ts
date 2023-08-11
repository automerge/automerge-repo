import EventEmitter from "eventemitter3"
import {
  DocumentUnavailableMessageContents,
  RequestMessage,
  RequestMessageContents,
  SyncMessage,
  SyncMessageContents,
} from "../network/NetworkAdapter.js"

export abstract class Synchronizer extends EventEmitter<SynchronizerEvents> {
  abstract receiveSyncMessage(message: SyncMessage | RequestMessage): void
}

export interface SynchronizerEvents {
  message: (
    arg:
      | SyncMessageContents
      | RequestMessageContents
      | DocumentUnavailableMessageContents
  ) => void
}
