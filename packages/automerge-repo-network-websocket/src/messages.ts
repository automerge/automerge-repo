import type {
  Message,
  PeerId,
  PeerMetadata,
} from "@automerge/automerge-repo/slim"
import type { ProtocolVersion } from "./protocolVersion.js"

/** Sent by the client to the server to tell the server the clients PeerID */
export type JoinMessage = {
  type: "join"
  /** The PeerID of the client */
  senderId: PeerId

  /** Metadata presented by the peer  */
  peerMetadata: PeerMetadata

  /** The protocol version the client supports */
  supportedProtocolVersions: ProtocolVersion[]
}

/** Sent by the server in response to a "join" message to advertise the servers PeerID */
export type PeerMessage = {
  type: "peer"
  /** The PeerID of the server */
  senderId: PeerId

  /** Metadata presented by the peer  */
  peerMetadata: PeerMetadata

  /** The protocol version the server selected for this connection */
  selectedProtocolVersion: ProtocolVersion
  /** The PeerID of the client */
  targetId: PeerId
}

/** An error occurred. The other end will terminate the connection after sending this message */
export type ErrorMessage = {
  type: "error"
  /** The peer sending the message */
  senderId: PeerId
  /** A description of the error*/
  message: string
  /** The PeerID of the client */
  targetId: PeerId
}

/** A message from the client to the server */
export type FromClientMessage = JoinMessage | Message

/** A message from the server to the client */
export type FromServerMessage = PeerMessage | ErrorMessage | Message

// TYPE GUARDS

export const isJoinMessage = (
  message: FromClientMessage
): message is JoinMessage => message.type === "join"

export const isPeerMessage = (
  message: FromServerMessage
): message is PeerMessage => message.type === "peer"

export const isErrorMessage = (
  message: FromServerMessage
): message is ErrorMessage => message.type === "error"
