import EventEmitter from "eventemitter3"
import { ChannelId, PeerId } from "../types"
import { OutboundPayload } from "../network/types"

export interface SyncMessages {
  message: (arg: OutboundPayload) => void
}

export interface Synchronizer extends EventEmitter<SyncMessages> {
  onSyncMessage(peerId: PeerId, channelId: ChannelId, message: Uint8Array): void
}
