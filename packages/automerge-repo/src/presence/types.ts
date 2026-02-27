import { PeerId } from "../types.js"
import { PRESENCE_MESSAGE_MARKER } from "./constants.js"

export type UserId = unknown
export type DeviceId = unknown

export type PresenceState = Record<string, any>

export type PeerStatesValue<State extends PresenceState> = Record<
  PeerId,
  PeerState<State>
>

export type PeerState<State extends PresenceState> = {
  peerId: PeerId
  lastActiveAt: number
  lastUpdateAt: number
  deviceId?: DeviceId
  userId?: UserId
  value: State
}

type PresenceMessageBase = {
  deviceId?: DeviceId
  userId?: UserId
}

type PresenceMessageUpdate = PresenceMessageBase & {
  type: "update"
  channel: string
  value: any
}

type PresenceMessageSnapshot = PresenceMessageBase & {
  type: "snapshot"
  state: any
}

type PresenceMessageHeartbeat = PresenceMessageBase & {
  type: "heartbeat"
}

type PresenceMessageGoodbye = PresenceMessageBase & {
  type: "goodbye"
}

export type PresenceMessage = {
  [PRESENCE_MESSAGE_MARKER]:
    | PresenceMessageUpdate
    | PresenceMessageSnapshot
    | PresenceMessageHeartbeat
    | PresenceMessageGoodbye
}

export type PresenceMessageType =
  PresenceMessage[typeof PRESENCE_MESSAGE_MARKER]["type"]

type WithPeerId = { peerId: PeerId }

export type PresenceEventUpdate = PresenceMessageUpdate & WithPeerId
export type PresenceEventSnapshot = PresenceMessageSnapshot & WithPeerId
export type PresenceEventHeartbeat = PresenceMessageHeartbeat & WithPeerId
export type PresenceEventGoodbye = PresenceMessageGoodbye & WithPeerId

/**
 * Events emitted by Presence when ephemeral messages are received from peers.
 */
export type PresenceEvents = {
  /**
   * Handle a state update broadcast by a peer.
   */
  update: (msg: PresenceEventUpdate) => void
  /**
   * Handle a full state snapshot broadcast by a peer.
   */
  snapshot: (msg: PresenceEventSnapshot) => void
  /**
   * Handle a heartbeat broadcast by a peer.
   */
  heartbeat: (msg: PresenceEventHeartbeat) => void
  /**
   * Handle a disconnection broadcast by a peer.
   */
  goodbye: (msg: PresenceEventGoodbye) => void
}

export type PresenceConfig<State extends PresenceState> = {
  /** The full initial state to broadcast to peers */
  initialState: State
  /** How frequently to send heartbeats (default {@link DEFAULT_HEARTBEAT_INTERVAL_MS}) */
  heartbeatMs?: number
  /** How long to wait until forgetting peers with no activity  (default {@link DEFAULT_PEER_TTL_MS}) */
  peerTtlMs?: number
}
