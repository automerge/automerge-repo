import EventEmitter from "eventemitter3"
import { PeerId, Message } from "../types.js"

export abstract class NetworkAdapter extends EventEmitter<NetworkAdapterEvents> {
  abstract send(message: Message): void
}

export interface NetworkAdapterEvents {
  open: () => void
  close: () => void
  message: (payload: Message) => void
}
