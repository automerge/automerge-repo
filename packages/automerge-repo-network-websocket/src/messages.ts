import { Message, PeerId } from "@automerge/automerge-repo"

export type LeaveMessage = {
  type: "leave"
  senderId: PeerId
}

export type JoinMessage = {
  type: "join"
  senderId: PeerId
}

export type PeerMessage = {
  type: "peer"
  senderId: PeerId
}

export type FromClientMessage = JoinMessage | LeaveMessage | Message

export type FromServerMessage = PeerMessage | Message
