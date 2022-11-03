import * as CBOR from "cbor-x"
import EventEmitter from "eventemitter3"
import { ChannelId, PeerId } from "."
import {
  ALL_PEERS_ID,
  OutboundMessageDetails,
} from "./network/NetworkSubsystem.js"
// TODO: why did I need a .js here?

export interface EphemeralDataDetails {
  channelId: ChannelId
  peerId: PeerId
  data: unknown
}

export type EphemeralDataMessageEvents = {
  message: (event: OutboundMessageDetails) => void
  data: (event: EphemeralDataDetails) => void
}

/**
 * Ephemeral Data
 * -----
 *
 * Not all that glitters is gold.
 *
 * It's useful to have a mechanism to send around short-lived data like cursor
 * positions, presence, or heartbeats. This kind of data is often high-bandwidth
 * and low-utility to persist so... this lets you communicate without that.
 *
 */
export class EphemeralData extends EventEmitter<EphemeralDataMessageEvents> {
  data: { [channelId: ChannelId]: { [peer: PeerId]: unknown } } = {}

  // Send an ephemeral message to anyone listening to this DocHandle
  broadcast(channelId: ChannelId, message: unknown) {
    const cbor = CBOR.encode(message)
    this.emit("message", {
      targetId: ALL_PEERS_ID,
      channelId,
      message: cbor,
    })
  }

  receive(senderId: PeerId, channelId: ChannelId, message: Uint8Array) {
    const data = CBOR.decode(message)
    this.emit("data", { peerId: senderId, channelId, data })
  }
}
