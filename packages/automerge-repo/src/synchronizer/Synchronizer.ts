import EventEmitter from "eventemitter3"
import { ChannelId, OutboundMessageDetails, PeerId } from "../types"

export interface SyncMessages {
  message: (arg: OutboundMessageDetails) => void
}

export interface Synchronizer extends EventEmitter<SyncMessages> {
  onSyncMessage(peerId: PeerId, channelId: ChannelId, message: Uint8Array): void
}
