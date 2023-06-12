import EventEmitter from "eventemitter3"
import { PeerId, Message } from "../types.js"

export abstract class NetworkAdapter extends EventEmitter<NetworkAdapterEvents> {
  peerId?: PeerId
  abstract connect(peerId: PeerId): void
  abstract sendMessage(message: Message): void
}

// events & payloads

export interface NetworkAdapterEvents {
  open: (payload: OpenPayload) => void
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
  channelId: string // TODO
}

export interface PeerDisconnectedPayload {
  peerId: PeerId
}
