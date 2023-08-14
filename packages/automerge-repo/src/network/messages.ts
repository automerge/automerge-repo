// utilities

import { SessionId } from "../EphemeralData"
import { ChannelId, DocumentId, PeerId } from "../types"

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

export function isEphemeralMessage(
  message: Message | MessageContents
): message is EphemeralMessage | EphemeralMessageContents {
  return message.type === "broadcast"
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

export type MessageContents = SyncMessageContents | EphemeralMessageContents

export type Message = SyncMessage | EphemeralMessage
