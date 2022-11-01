import * as CBOR from "cbor-x"
import EventEmitter from "eventemitter3"
import { ChannelId, PeerId } from "."
import {
  ALL_PEERS_ID,
  OutboundMessageDetails,
} from "./network/NetworkSubsystem"

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
 * Not all data needs to be persisted to disk. For example, selections,
 * cursor positions, and presence heartbeats are all quite disposible.
 *
 * This class tracks the last broadcast value on a per-peer basis for
 * a particular key / channelId.
 *
 * Note that as we navigate around the site we don't want to see "missing"
 * data for a moment if the same data shows up multiple places.
 *
 * Thus, we cache the last known value of each atom of data to prevent flicker.
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

  // Messages are cached until replaced in order to avoid "flicker"
  // or other rendering bugs.
  // We may want to remove values when peers disconnect.
  receiveBroadcast(
    senderId: PeerId,
    channelId: ChannelId,
    message: Uint8Array
  ) {
    const data = CBOR.decode(message)
    const currentValue = this.data[channelId] || {}
    this.data[channelId] = { ...currentValue, [senderId]: data }
    this.emit("data", { peerId: senderId, channelId, data })
  }

  value(channelId: ChannelId): Record<PeerId, unknown> | undefined {
    return this.data[channelId]
  }
}
