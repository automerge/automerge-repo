import EventEmitter from "eventemitter3"
import { PeerId, ChannelId } from "../types.js"

export abstract class NetworkAdapter extends EventEmitter<NetworkAdapterEvents> {
  peerId?: PeerId // hmmm, maybe not

  abstract connect(url?: string): void

  abstract sendMessage(
    peerId: PeerId,
    channelId: ChannelId,
    message: Uint8Array,
    broadcast: boolean
  ): void

  abstract join(): void

  abstract leave(): void
}

// events & payloads

export interface NetworkAdapterEvents {
  open: (payload: OpenPayload) => void
  close: () => void
  "peer-candidate": (payload: PeerCandidatePayload) => void
  "peer-disconnected": (payload: PeerDisconnectedPayload) => void
  message: (payload: InboundMessagePayload) => void
}

export interface OpenPayload {
  network: NetworkAdapter
}

export interface PeerCandidatePayload {
  peerId: PeerId
}

export interface MessagePayload {
  targetId: PeerId
  channelId: ChannelId
  message: Uint8Array
  broadcast: boolean
}

export interface InboundMessagePayload extends MessagePayload {
  type?: string
  senderId: PeerId
}

export interface PeerDisconnectedPayload {
  peerId: PeerId
}
