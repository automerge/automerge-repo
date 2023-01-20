import EventEmitter from "eventemitter3"
import { ChannelId, PeerId } from "../types"
import { MessagePayload } from "../network/NetworkAdapter"

export abstract class Synchronizer extends EventEmitter<SynchronizerEvents> {
  abstract onSyncMessage(
    peerId: PeerId,
    channelId: ChannelId,
    message: Uint8Array
  ): void
}

export interface SynchronizerEvents {
  message: (arg: MessagePayload) => void
}
