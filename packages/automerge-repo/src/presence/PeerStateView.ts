import { PeerState, PeerStatesValue, PresenceState } from "./types.js"

export type GetCohortOpts<State extends PresenceState, SummaryState> = {
  /**
   * Function to derive a key from a peer state. This can be used to group peers
   * and consider presence activity by user or device rather than by peer (when
   * a user has multiple devices, or multiple peers on a single device.)
   *
   * @param state state of a peer
   * @returns key that should be used to consolidate activity from that peer
   */
  keyFn?: (state: PeerState<State>) => PropertyKey
  /**
   * Function to summarize the presence activity from several different peers in
   * a cohort.
   *
   * @param states states of all peers in a cohort, as grouped by {@param keyFn}
   * @returns a value summarizing presence for this cohort
   */
  summaryFn?: (states: PeerState<State>[]) => SummaryState
}

export class PeerStateView<State extends PresenceState> {
  readonly value

  constructor(value: PeerStatesValue<State>) {
    this.value = value
  }

  /**
   * Get the presence state of all peers, grouped by cohort. By default, each
   * peer is its own cohort, but presence activity can be aggregated by user or
   * device instead.
   *
   * @param opts
   * @returns presence state for all cohorts
   */
  getCohortStates<SummaryState = PeerState<State>>(
    opts?: GetCohortOpts<State, SummaryState>
  ) {
    const keyFn = opts?.keyFn ?? peerIdentity
    const summaryFn =
      opts?.summaryFn ??
      (getLastActivePeer as (states: PeerState<State>[]) => SummaryState)
    const statesByCohortKey = Object.values(this.value).reduce(
      (byKey, curr) => {
        const key = keyFn(curr)
        if (!(key in byKey)) {
          byKey[key] = []
        }
        byKey[key].push(curr)

        return byKey
      },
      {} as Record<PropertyKey, PeerState<State>[]>
    )
    return Object.entries(statesByCohortKey).reduce((result, [key, states]) => {
      result[key] = summaryFn(states)
      return result
    }, {} as Record<PropertyKey, SummaryState>)
  }
}

export const peerIdentity = <State extends PresenceState>(
  peer: PeerState<State>
) => peer.peerId

/**
 * Return the peer from this group that sent a state update most recently
 *
 * @param peers
 * @returns id of most recently seen peer
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
 * Return the most-recently-seen peer from this group.
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
