import EventEmitter from "eventemitter3"
import { ChannelId, PeerId } from "../network/NetworkSubsystem"

export interface SyncMessageArg {
  peerId: PeerId
  channelId: ChannelId
  message: Uint8Array
}

export interface SyncMessages {
  message: (arg: SyncMessageArg) => void
}

export interface Synchronizer extends EventEmitter<SyncMessages> {
  onSyncMessage(peerId: PeerId, channelId: ChannelId, message: Uint8Array): void
}
