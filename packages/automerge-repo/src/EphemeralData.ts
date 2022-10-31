import * as CBOR from "cbor-x"
import EventEmitter from "eventemitter3"
import { ChannelId, PeerId } from "."
import { NetworkMessageDetails } from "./network/NetworkSubsystem"

export type EphemeralDataMessageEvents = {
  message: (event: NetworkMessageDetails) => void
}

export class EphemeralData extends EventEmitter<EphemeralDataMessageEvents> {
  data: { [channelId: ChannelId]: { [peer: PeerId]: unknown } } = {}

  // Send an ephemeral message to anyone listening to this DocHandle
  broadcast(channelId: ChannelId, message: unknown) {
    const cbor = CBOR.encode(message)
    this.emit("message", {
      peerId: "*" as PeerId, // TODO: should I make "*" a special PeerId?
      channelId,
      message: cbor,
    })
  }

  // Messages are cached until replaced in order to avoid "flicker"
  // or other rendering bugs.
  // We may want to remove values when peers disconnect.
  receiveBroadcast(
    senderId: PeerId,
    channelId: ChannelId,
    message: Uint8Array
  ) {
    const currentValue = this.data[channelId] || {}
    this.data[channelId] = { ...currentValue, [senderId]: CBOR.decode(message) }
  }

  value(peerId: PeerId, channelId: ChannelId): unknown {
    const channelData = this.data[channelId]
    if (!channelData) {
      return
    }

    return channelData[peerId] // could be undefined, of course
  }
}
