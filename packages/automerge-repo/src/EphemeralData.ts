import { decode, encode } from "cbor-x"
import EventEmitter from "eventemitter3"
import { ChannelId, PeerId } from "./index.js"
import {
  EphemeralMessage,
  EphemeralMessageContents,
} from "./network/messages.js"

/**
 * EphemeralData provides a mechanism to broadcast short-lived data — cursor positions, presence,
 * heartbeats, etc. — that is useful in the moment but not worth persisting.
 */
export class EphemeralData extends EventEmitter<EphemeralDataMessageEvents> {
  #count = 0
  #sessionId: SessionId = Math.random().toString(36).slice(2) as SessionId

  get sessionId() {
    return this.#sessionId
  }

  /** Broadcast an ephemeral message */
  broadcast(channelId: ChannelId, message: unknown) {
    const messageBytes = encode(message)

    this.emit("message", {
      type: "broadcast",
      count: ++this.#count,
      channelId,
      sessionId: this.#sessionId,
      data: messageBytes,
    })
  }

  /** Receive an ephemeral message */
  receive(message: EphemeralMessage) {
    const data = decode(message.data)
    this.emit("data", {
      peerId: message.senderId,
      channelId: message.channelId,
      data,
    })
  }
}

// types

export type SessionId = string & { __SessionId: false }

export interface EphemeralDataPayload {
  channelId: ChannelId
  peerId: PeerId
  data: { peerId: PeerId; channelId: ChannelId; data: unknown }
}

export type EphemeralDataMessageEvents = {
  message: (event: EphemeralMessageContents) => void
  data: (event: EphemeralDataPayload) => void
}
