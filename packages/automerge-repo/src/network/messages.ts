// utilities
import { SessionId } from "../EphemeralData"
import { DocumentId, PeerId } from "../types"

export function isValidMessage(
  message: NetworkAdapterMessage
): message is
  | SyncMessage
  | EphemeralMessage
  | RequestMessage
  | DocumentUnavailableMessage {
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
  message: NetworkAdapterMessage
): message is DocumentUnavailableMessage {
  return message.type === "doc-unavailable"
}

export function isRequestMessage(
  message: NetworkAdapterMessage
): message is RequestMessage {
  return message.type === "request"
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

export interface DocumentUnavailableMessageContents {
  type: "doc-unavailable"
  documentId: DocumentId
  targetId: PeerId
}

export type DocumentUnavailableMessage = SyncMessageEnvelope &
  DocumentUnavailableMessageContents

export interface RequestMessageContents {
  type: "request"
  data: Uint8Array
  targetId: PeerId
  documentId: DocumentId
}

export type RequestMessage = SyncMessageEnvelope & RequestMessageContents

export type MessageContents =
  | SyncMessageContents
  | EphemeralMessageContents
  | RequestMessageContents
  | DocumentUnavailableMessageContents

export type Message =
  | SyncMessage
  | EphemeralMessage
  | RequestMessage
  | DocumentUnavailableMessage

export type SynchronizerMessage =
  | SyncMessage
  | RequestMessage
  | DocumentUnavailableMessage

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
