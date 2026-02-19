import { PeerState, PeerStatesValue, PresenceState } from "./types.js"

export type GetStatesOpts<State extends PresenceState, SummaryState> = {
  /**
   * Function to derive a grouping key from a peer state. This can be used to
   * group peers and consider presence activity by an arbitrary attribute of the
   * presence state (e.g., user or device) rather than by peer.
   *
   * This is useful when a user has multiple devices, or multiple peers (e.g.,
   * tabs) on a single device.
   *
   * @param state state of a peer
   * @returns key that should be used to consolidate activity from that peer
   */
  groupingFn?: (state: PeerState<State>) => PropertyKey
  /**
   * Function to summarize the presence activity from several different peers in
   * a group.
   *
   * @param states states of all peers in a group, as grouped by {@param keyFn}
   * @returns a value summarizing presence for this group
   */
  summaryFn?: (states: PeerState<State>[]) => SummaryState
}

/**
 * A grouped view of peer states.
 */
export class PeerStateView<State extends PresenceState> {
  readonly value

  constructor(value: PeerStatesValue<State>) {
    this.value = value
  }

  /**
   * Get the presence state of all peers. By default, each peer is its own
   * group, but presence activity can be aggregated by arbitrary criteria.
   *
   * @param opts
   * @returns presence state for all groups
   */
  getStates<SummaryState = PeerState<State>>(
    opts?: GetStatesOpts<State, SummaryState>
  ) {
    const groupingFn = opts?.groupingFn ?? peerIdentity
    const summaryFn =
      opts?.summaryFn ??
      (getLastActivePeer as (states: PeerState<State>[]) => SummaryState)
    const statesByKey = Object.values(this.value).reduce((byKey, curr) => {
      const key = groupingFn(curr)
      if (!(key in byKey)) {
        byKey[key] = []
      }
      byKey[key].push(curr)

      return byKey
    }, {} as Record<PropertyKey, PeerState<State>[]>)
    return Object.entries(statesByKey).reduce((result, [key, states]) => {
      result[key] = summaryFn(states)
      return result
    }, {} as Record<PropertyKey, SummaryState>)
  }
}

/**
 * Get the peerId of this peer.
 *
 * @param peer
 * @returns peer id
 */
export function peerIdentity<State extends PresenceState>(
  peer: PeerState<State>
) {
  return peer.peerId
}

/**
 * Find the peer that most recently sent a state update.
 *
 * @param peers
 * @returns id of most recently active peer
 */
export function getLastActivePeer<State extends PresenceState>(
  peers: PeerState<State>[]
) {
  let freshestLastActiveAt: number
  return peers.reduce((freshest, curr) => {
    const lastActiveAt = curr.lastActiveAt
    if (!lastActiveAt) {
      return freshest
    }

    if (!freshest || lastActiveAt > freshestLastActiveAt) {
      freshestLastActiveAt = lastActiveAt
      return curr
    }

    return freshest
  }, undefined as PeerState<State> | undefined)
}

/**
 * Find the peer that most recently sent a heartbeat.
 *
 * @param peers
 * @returns id of most recently seen peer
 */
export function getLastSeenPeer<State extends PresenceState>(
  peers: PeerState<State>[]
) {
  let freshestLastSeenAt: number
  return peers.reduce((freshest, curr) => {
    const lastSeenAt = curr.lastSeenAt
    if (!lastSeenAt) {
      return freshest
    }

    if (!freshest || lastSeenAt > freshestLastSeenAt) {
      freshestLastSeenAt = lastSeenAt
      return curr
    }

    return freshest
  }, undefined as PeerState<State> | undefined)
}
