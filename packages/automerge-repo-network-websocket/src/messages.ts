import { type Message, type PeerId } from "@automerge/automerge-repo"
import { ProtocolVersion } from "./protocolVersion.js"

/** The sender is disconnecting */
export type LeaveMessage = {
  type: "leave"
  senderId: PeerId
}

/** Sent by the client to the server to tell the server the clients PeerID */
export type JoinMessage = {
  type: "join"
  /** The PeerID of the client */
  senderId: PeerId
  /** The protocol version the client supports */
  supportedProtocolVersions: ProtocolVersion[]
}

/** Sent by the server in response to a "join" message to advertise the servers PeerID */
export type PeerMessage = {
  type: "peer"
  /** The PeerID of the server */
  senderId: PeerId
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

// This adapter doesn't use NetworkAdapterMessage, it has its own idea of how to handle join/leave
/** A message from the client to the server */
export type FromClientMessage = JoinMessage | LeaveMessage | Message
/** A message from the server to the client */
export type FromServerMessage = PeerMessage | ErrorMessage | Message
