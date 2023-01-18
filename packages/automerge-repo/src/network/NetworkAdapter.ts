import EventEmitter from "eventemitter3"
import { PeerId, ChannelId } from "../types"

export abstract class NetworkAdapter extends EventEmitter<NetworkAdapterEvents> {
  peerId?: PeerId // hmmm, maybe not

  abstract connect(url?: string): void

  abstract sendMessage(
    peerId: PeerId,
    channelId: ChannelId,
    message: Uint8Array,
    broadcast: boolean
  ): void

  abstract join(channelId: ChannelId): void

  abstract leave(channelId: ChannelId): void
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

interface PeerCandidatePayload {
  peerId: PeerId
  channelId: ChannelId
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
