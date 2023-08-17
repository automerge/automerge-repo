// utilities
import { SessionId } from "../EphemeralData"
import { DocumentId, PeerId } from "../types"

export function isValidMessage(
  message: NetworkAdapterMessage
): message is SyncMessage | EphemeralMessage {
  return (
    typeof message === "object" &&
    typeof message.type === "string" &&
    typeof message.senderId === "string" &&
    (isSyncMessage(message) || isEphemeralMessage(message))
  )
}

export function isSyncMessage(
  message: NetworkAdapterMessage
): message is SyncMessage {
  return message.type === "sync"
}

export function isEphemeralMessage(
  message: NetworkAdapterMessage | MessageContents
): message is EphemeralMessage | EphemeralMessageContents {
  return message.type === "ephemeral"
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
  senderId: PeerId
  count: number
  sessionId: SessionId
}

export interface EphemeralMessageContents {
  type: "ephemeral"
  targetId: PeerId
  documentId: DocumentId
  data: Uint8Array
}

export type EphemeralMessage = EphemeralMessageEnvelope &
  EphemeralMessageContents

export type MessageContents = SyncMessageContents | EphemeralMessageContents

export type Message = SyncMessage | EphemeralMessage

type ArriveMessage = {
  senderId: PeerId
  type: "arrive"
}

type WelcomeMessage = {
  senderId: PeerId
  targetId: PeerId
  type: "welcome"
}

export type NetworkAdapterMessage = ArriveMessage | WelcomeMessage | Message
