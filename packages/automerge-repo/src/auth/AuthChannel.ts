import EventEmitter from "eventemitter3"
import {
  InboundMessagePayload,
  NetworkAdapter,
} from "../network/NetworkAdapter.js"
import type { ChannelId, PeerId } from "../types"
import debug from "debug"

const AUTH_CHANNEL = "auth_channel" as ChannelId

/**
 * An AuthChannel is a channel that is used to exchange authentication messages over a network adapter. It is created by
 * the AuthProvider.
 */
export class AuthChannel extends EventEmitter<AuthChannelEvents> {
  #log: debug.Debugger
  #closed = false

  constructor(private networkAdapter: NetworkAdapter, private peerId: PeerId) {
    super()
    this.#log = debug(`automerge-repo:authchannel:${peerId}`)
    this.networkAdapter.on("message", this.#onMessage)
  }

  send(message: Uint8Array) {
    this.#log("sending %o", messageSummary({ peerId: this.peerId, message }))
    if (this.#closed) throw new Error("AuthChannel is closed")
    this.networkAdapter.sendMessage(this.peerId, AUTH_CHANNEL, message, false)
  }

  close() {
    this.removeAllListeners()
    this.networkAdapter.off("message", this.#onMessage)
    this.#closed = true
  }

  #onMessage = (payload: InboundMessagePayload) => {
    if (payload.channelId === AUTH_CHANNEL) {
      this.#log("received %o", messageSummary(payload))
      this.emit("message", payload.message)
    }
  }
}

export interface AuthChannelEvents {
  message: (message: Uint8Array) => void
}

const messageSummary = (payload: any) => {
  const { message } = payload
  return {
    ...payload,
    ...(message ? { message: message.byteLength } : {}),
  }
}
