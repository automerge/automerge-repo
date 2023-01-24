import EventEmitter from "eventemitter3"
import { ChannelId, PeerId } from "../types"
import { MessagePayload } from "../network/NetworkAdapter"

// Q: not sure this abstract class is buying us anything

export abstract class Synchronizer extends EventEmitter<SynchronizerEvents> {
  abstract receiveSyncMessage(
    peerId: PeerId,
    channelId: ChannelId,
    message: Uint8Array
  ): void
}

export interface SynchronizerEvents {
  message: (arg: MessagePayload) => void
}
