import { RepoId, PeerId } from "../types.js"
import { PRESENCE_MESSAGE_MARKER } from "./constants.js"

export type PresenceState = Record<string, any>

/** Peer states by the publishing Repo's {@link PeerState.originId}. */
export type PeerStatesValue<State extends PresenceState> = Record<
  RepoId,
  PeerState<State>
>

export type PeerState<State extends PresenceState> = {
  /** The peer that sent this state, as authenticated by the backend; several Repos may share one. */
  senderId: PeerId
  /** The Repo this state was sent for; tells one peer's Repos apart. Not authenticated. */
  originId: RepoId
  lastActiveAt: number
  lastSeenAt: number
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

type WithSource = { senderId: PeerId; originId: RepoId }

export type PresenceEventUpdate = PresenceMessageUpdate & WithSource
export type PresenceEventSnapshot = PresenceMessageSnapshot & WithSource
export type PresenceEventHeartbeat = PresenceMessageHeartbeat & WithSource
export type PresenceEventGoodbye = PresenceMessageGoodbye & WithSource
export type PresenceEventPruning = { pruned: RepoId[] }

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
