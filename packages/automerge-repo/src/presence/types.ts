import { PeerId } from "../types.js"
import { PRESENCE_MESSAGE_MARKER } from "./constants.js"

export type PresenceState = Record<string, any>

export type PeerStatesValue<State extends PresenceState> = Record<
  PeerId,
  PeerState<State>
>

export type PeerState<State extends PresenceState> = {
  peerId: PeerId
  lastActiveAt: number
  lastSeenAt: number
  /**
   * Whether a full state snapshot has been received from this peer. Entries
   * created by partial `update` messages have this set to false until a
   * `snapshot` message arrives.
   */
  hasSnapshot: boolean
  value: State
}

type PresenceMessageUpdate = {
  type: "update"
  channel: string
  value: any
}

type PresenceMessageSnapshot = {
  type: "snapshot"
  state: any
  /**
   * When true, the sender is announcing its state to newly discovered peers
   * and asks peers that already know it to reply with their own snapshot.
   */
  request?: boolean
}

type PresenceMessageHeartbeat = {
  type: "heartbeat"
}

type PresenceMessageGoodbye = {
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
export type PresenceEventPruning = { pruned: PeerId[] }

/**
 * Events emitted by Presence when ephemeral messages are received from peers.
 */
export type PresenceEvents = {
  /**
   * Handle a state update broadcast by a peer.
   */
  update: (e: PresenceEventUpdate) => void
  /**
   * Handle a full state snapshot broadcast by a peer.
   */
  snapshot: (e: PresenceEventSnapshot) => void
  /**
   * Handle a heartbeat broadcast by a peer.
   */
  heartbeat: (e: PresenceEventHeartbeat) => void
  /**
   * Handle a disconnection broadcast by a peer.
   */
  goodbye: (e: PresenceEventGoodbye) => void
  /**
   * Handle one or more peers being pruned
   */
  pruning: (e: PresenceEventPruning) => void
}

export type PresenceConfig<State extends PresenceState> = {
  /** The full initial state to broadcast to peers */
  initialState: State
  /** How frequently to send heartbeats (default {@link DEFAULT_HEARTBEAT_INTERVAL_MS}) */
  heartbeatMs?: number
  /** How long to wait until forgetting peers with no activity  (default {@link DEFAULT_PEER_TTL_MS}) */
  peerTtlMs?: number
}
