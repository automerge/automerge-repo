import { EventEmitter } from "eventemitter3"
import { NetworkAdapter } from "../network/NetworkAdapter.js"
import type { PeerId } from "../types.js"
import debug from "debug"
import { AuthMessage, Message, isAuthMessage } from "../network/messages.js"

/**
 * An AuthChannel is a channel that is used to exchange authentication messages over a network
 * adapter. It is created by the AuthProvider.
 */
export class AuthChannel<TPayload = any> //
  extends EventEmitter<AuthChannelEvents<TPayload>>
{
  log: debug.Debugger
  closed = false

  networkAdapter: NetworkAdapter
  senderId: PeerId
  targetId: PeerId

  constructor(networkAdapter: NetworkAdapter, peerId: PeerId) {
    super()
    this.log = debug(`automerge-repo:authchannel:${peerId}`)
    this.networkAdapter = networkAdapter
    this.senderId = networkAdapter.peerId!
    this.targetId = peerId
    this.networkAdapter.on("message", this.onMessage)
  }

  send(payload: TPayload) {
    if (this.closed) throw new Error("AuthChannel is closed")
    this.networkAdapter.send({
      type: "auth",
      senderId: this.senderId,
      targetId: this.targetId,
      payload,
    })
  }

  close() {
    this.removeAllListeners()
    this.networkAdapter.off("message", this.onMessage)
    this.closed = true
  }

  onMessage = (message: Message) => {
    if (isAuthMessage(message)) {
      this.emit("message", (message as AuthMessage<TPayload>).payload)
    }
  }
}

export interface AuthChannelEvents<TPayload> {
  message: (payload: TPayload) => void
}
