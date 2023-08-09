import EventEmitter from "eventemitter3"
import { SessionId } from "../EphemeralData.js"
import { ChannelId, DocumentId, PeerId } from "../types.js"

export abstract class NetworkAdapter extends EventEmitter<NetworkAdapterEvents> {
  peerId?: PeerId // hmmm, maybe not

  abstract connect(url?: string): void

  abstract send(message: Message): void

  abstract join(): void

  abstract leave(): void
}

// utilities

export function isValidMessage(message: Message): boolean {
  return (
    typeof message === "object" &&
    typeof message.type === "string" &&
    typeof message.senderId === "string" &&
    (isSyncMessage(message) || isEphemeralMessage(message))
  )
}

export function isSyncMessage(message: Message): message is SyncMessage {
  return message.type === "sync"
}

export function isEphemeralMessage<T extends { type: string }>(
  message: Message
): message is EphemeralMessage {
  return message.type === "broadcast"
}

// events & payloads

export interface NetworkAdapterEvents {
  open: (payload: OpenPayload) => void
  close: () => void
  "peer-candidate": (payload: PeerCandidatePayload) => void
  "peer-disconnected": (payload: PeerDisconnectedPayload) => void
  message: (payload: Message) => void
}

export interface SyncMessage {
  type: "sync"
  data: Uint8Array
  targetId: PeerId
  documentId: DocumentId
  senderId: PeerId
}

export interface EphemeralMessage {
  type: "broadcast"
  count: number
  channelId: ChannelId
  senderId: PeerId
  sessionId: SessionId
  data: Uint8Array
}

export type Message = SyncMessage | EphemeralMessage

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
