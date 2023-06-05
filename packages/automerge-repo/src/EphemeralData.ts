import { decode, encode } from "cbor-x"
import EventEmitter from "eventemitter3"
import { ChannelId, PeerId } from "./index.js"
import { MessagePayload } from "./network/NetworkAdapter.js"

/**
 * EphemeralData provides a mechanism to broadcast short-lived data — cursor positions, presence,
 * heartbeats, etc. — that is useful in the moment but not worth persisting.
 */
export class EphemeralData extends EventEmitter<EphemeralDataMessageEvents> {
  /** Broadcast an ephemeral message */
  broadcast(channelId: ChannelId, message: unknown) {
    const messageBytes = encode(message)

    this.emit("message", {
      targetId: "*" as PeerId, // TODO: we don't really need a targetId for broadcast
      channelId: ("m/" + channelId) as ChannelId,
      message: messageBytes,
      broadcast: true,
    })
  }

  /** Receive an ephemeral message */
  receive(senderId: PeerId, grossChannelId: ChannelId, message: Uint8Array) {
    const data = decode(message)
    const channelId = grossChannelId.slice(2) as ChannelId
    this.emit("data", {
      peerId: senderId,
      channelId,
      data,
    })
  }
}

// types

export interface EphemeralDataPayload {
  channelId: ChannelId
  peerId: PeerId
  data: { peerId: PeerId; channelId: ChannelId; data: unknown }
}

export type EphemeralDataMessageEvents = {
  message: (event: MessagePayload) => void
  data: (event: EphemeralDataPayload) => void
}
