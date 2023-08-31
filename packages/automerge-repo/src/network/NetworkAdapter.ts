import { EventEmitter } from "eventemitter3"
import { PeerId } from "../types.js"
import { Message } from "./messages.js"

export abstract class NetworkAdapter extends EventEmitter<NetworkAdapterEvents> {
  peerId?: PeerId // hmmm, maybe not

  abstract connect(peerId: PeerId): void

  abstract send(message: Message): void

  abstract disconnect(): void
}

// events & payloads

export interface NetworkAdapterEvents {
  ready: (payload: OpenPayload) => void
  close: () => void
  "peer-candidate": (payload: PeerCandidatePayload) => void
  "peer-disconnected": (payload: PeerDisconnectedPayload) => void
  message: (payload: Message) => void
}

export interface OpenPayload {
  network: NetworkAdapter
}

export interface PeerCandidatePayload {
  peerId: PeerId
}

export interface PeerDisconnectedPayload {
  peerId: PeerId
}
