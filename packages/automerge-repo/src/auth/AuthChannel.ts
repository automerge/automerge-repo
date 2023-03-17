import EventEmitter from "eventemitter3"
import { InboundMessagePayload } from "../network/NetworkAdapter.js"

export class AuthChannel extends EventEmitter<AuthChannelEvents> {
  constructor(public send: (message: Uint8Array) => void) {
    super()
  }
}

export interface AuthChannelEvents {
  message: (payload: InboundMessagePayload) => void
}
