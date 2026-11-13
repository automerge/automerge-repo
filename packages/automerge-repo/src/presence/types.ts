import { RepoId, PeerId } from "../types.js"
import { PRESENCE_MESSAGE_MARKER } from "./constants.js"

export type PresenceState = Record<string, any>

/** An ephemeral message as Presence receives it. */
export type PresenceInbound = {
  /** The peer that sent it, as the backend authenticated it; several Repos
   * may share one. */
  senderId: PeerId
  /** The Repo that sent it, telling one peer's Repos apart; claimed, not
   * authenticated. */
  originId: RepoId
  /** What the sender passed to `broadcast`. */
  message: unknown
}

/**
 * The contract a handle must meet to be used with {@link Presence}. Core
 * handles do not: a backend adds ephemeral messaging to its Repo's handles
 * with a handle extension, under whatever name and with whatever else it
 * likes, and any handle of this shape works.
 *
 * For a backend to provide it, its extension must:
 * - add `broadcast(message)`: encode `message` when called, tag it with the
 *   sending Repo's ID (`context.repoId`), and send it through the document's
 *   session (`context.session`) to the peers that have the document open.
 *   Best effort: log a failure to send, never throw or reject for one;
 * - on each message the backend delivers for the document (an `extension`
 *   session event of its kind), drop it if it is tagged with this Repo's own
 *   ID, since Presence would take its own broadcasts for a new peer;
 *   otherwise emit `ephemeral-message` on every handle of the document
 *   (`context.emit`);
 * - report as `senderId` the peer the backend authenticated, and as
 *   `originId` the sending Repo's tag, so that several Repos behind one peer
 *   stay distinct;
 * - declare `broadcast` and `ephemeral-message` in its `ExtensionTypes`, so
 *   that handles are typed with them.
 *
 * The backend lists the extension in `handleExtensions`, and its sessions
 * implement whatever the extension calls in order to send. The Subduction
 * backend's `ephemeral` extension is one such implementation, and asserts at
 * compile time that its handles fit this interface.
 */
export interface PresenceHandle {
  broadcast(message: unknown): void
  on(
    event: "ephemeral-message",
    fn: (payload: PresenceInbound) => void
  ): unknown
  off(
    event: "ephemeral-message",
    fn?: (payload: PresenceInbound) => void
  ): unknown
}

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
