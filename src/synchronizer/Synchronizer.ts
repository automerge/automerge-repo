import EventEmitter from 'eventemitter3'

export interface SyncMessageArg {
  peerId: string
  documentId: string
  message: Uint8Array
}
export interface SyncMessages {
  'message': (arg: SyncMessageArg) => void
}

export interface Synchronizer extends EventEmitter<SyncMessages> {
  onSyncMessage(documentId: string, message: Uint8Array): void
}
