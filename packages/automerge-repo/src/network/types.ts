import EventEmitter from "eventemitter3"
import { PeerId, ChannelId } from "../types"

interface AdapterOpenPayload {
  network: NetworkAdapter
}
interface PeerCandidatePayload {
  peerId: PeerId
  channelId: ChannelId
}
interface PeerPayload {
  peerId: PeerId
  channelId: ChannelId
}

export interface OutboundPayload {
  targetId: PeerId
  channelId: ChannelId
  message: Uint8Array
  broadcast: boolean
}

export interface InboundPayload extends OutboundPayload {
  senderId: PeerId
}
interface DisconnectedPayload {
  peerId: PeerId
}

export interface NetworkAdapterEvents {
  open: (payload: AdapterOpenPayload) => void
  close: () => void
  "peer-candidate": (payload: PeerCandidatePayload) => void
  "peer-disconnected": (payload: DisconnectedPayload) => void
  message: (payload: InboundPayload) => void
}

export interface NetworkEvents {
  peer: (payload: PeerPayload) => void
  "peer-disconnected": (payload: DisconnectedPayload) => void
  message: (payload: InboundPayload) => void
}

export interface NetworkAdapter extends EventEmitter<NetworkAdapterEvents> {
  peerId?: PeerId // hmmm, maybe not
  connect(url?: string): void
  sendMessage(
    peerId: PeerId,
    channelId: ChannelId,
    message: Uint8Array,
    broadcast: boolean
  ): void
  join(channelId: ChannelId): void
  leave(channelId: ChannelId): void
}

export interface Peer extends EventEmitter<InboundPayload> {
  isOpen(): boolean
  close(): void
  send(channelId: ChannelId, msg: Uint8Array): void
}
