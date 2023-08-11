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
    (isSyncMessage(message) ||
      isEphemeralMessage(message) ||
      isRequestMessage(message) ||
      isDocumentUnavailableMessage(message))
  )
}

export function isDocumentUnavailableMessage(
  message: Message
): message is DocumentUnavailableMessage {
  return message.type === "doc-unavailable"
}

export function isSyncMessage(message: Message): message is SyncMessage {
  return message.type === "sync"
}

export function isRequestMessage(message: Message): message is RequestMessage {
  return message.type === "request"
}

export function isEphemeralMessage(
  message: Message | MessageContents
): message is EphemeralMessage | EphemeralMessageContents {
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

export interface SyncMessageEnvelope {
  senderId: PeerId
}

export interface SyncMessageContents {
  type: "sync"
  data: Uint8Array
  targetId: PeerId
  documentId: DocumentId
}

export interface RequestMessageContents {
  type: "request"
  data: Uint8Array
  targetId: PeerId
  documentId: DocumentId
}

export type RequestMessage = SyncMessageEnvelope & RequestMessageContents

export type SyncMessage = SyncMessageEnvelope & SyncMessageContents

export interface EphemeralMessageEnvelope {
  targetId: PeerId
  senderId: PeerId
}

export interface EphemeralMessageContents {
  type: "broadcast"
  count: number
  channelId: ChannelId
  sessionId: SessionId
  data: Uint8Array
}

export type EphemeralMessage = EphemeralMessageEnvelope &
  EphemeralMessageContents

export interface DocumentUnavailableMessageContents {
  type: "doc-unavailable"
  documentId: DocumentId
  targetId: PeerId
}

export type DocumentUnavailableMessage = SyncMessageEnvelope &
  DocumentUnavailableMessageContents

export type MessageContents = SyncMessageContents | EphemeralMessageContents

export type Message =
  | SyncMessage
  | EphemeralMessage
  | RequestMessage
  | DocumentUnavailableMessage

export type SynchronizerMessage =
  | SyncMessage
  | RequestMessage
  | DocumentUnavailableMessage

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
