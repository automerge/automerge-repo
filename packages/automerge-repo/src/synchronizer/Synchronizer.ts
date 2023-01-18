import EventEmitter from "eventemitter3"
import { ChannelId, PeerId } from "../types"
import { MessagePayload } from "../network/NetworkAdapter"

export interface SyncMessages {
  message: (arg: MessagePayload) => void
}

export interface Synchronizer extends EventEmitter<SyncMessages> {
  onSyncMessage(peerId: PeerId, channelId: ChannelId, message: Uint8Array): void
}
