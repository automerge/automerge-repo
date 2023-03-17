import EventEmitter from "eventemitter3"
import { NetworkAdapter } from "../network/NetworkAdapter.js"
import type { ChannelId, PeerId } from "../types"
import debug from "debug"

const AUTH_CHANNEL = "auth_channel" as ChannelId

export class AuthChannel extends EventEmitter<AuthChannelEvents> {
  log: debug.Debugger
  constructor(private networkAdapter: NetworkAdapter, private peerId: PeerId) {
    super()
    this.log = debug(`automerge-repo:authchannel:${peerId}`)
    this.networkAdapter.on("message", payload => {
      if (payload.channelId === AUTH_CHANNEL) {
        this.log("received %o", messageSummary(payload))
        this.emit("message", payload.message)
      }
    })
  }

  send(message: Uint8Array) {
    this.log("sending %o", messageSummary({ peerId: this.peerId, message }))
    this.networkAdapter.sendMessage(this.peerId, AUTH_CHANNEL, message, false)
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
