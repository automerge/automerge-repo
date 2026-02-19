import { PeerId } from "../types.js"
import { PeerStateView } from "./PeerStateView.js"
import { PresenceState } from "./types.js"

export class PeerPresenceInfo<State extends PresenceState> {
  #peerStates = new PeerStateView<State>({})

  /**
   * Build a new peer presence state.
   *
   * @param ttl in milliseconds - peers with no activity within this timeframe
   * are forgotten when {@link prune} is called.
   */
  constructor(readonly ttl: number) {}

  has(peerId: PeerId) {
    return peerId in this.#peerStates.value
  }

  /**
   * Record that we've seen the given peer recently.
   *
   * @param peerId
   */
  markSeen(peerId: PeerId) {
    if (!(peerId in this.#peerStates.value)) {
      // Ignore heartbeats from peers we have not seen before: they will send a snapshot
      return
    }
    this.#peerStates = new PeerStateView<State>({
      ...this.#peerStates.value,
      [peerId]: {
        ...this.#peerStates.value[peerId],
        lastSeenAt: Date.now(),
      },
    })
  }

  /**
   * Record a state update for the given peer. Note that existing state is not
   * overwritten.
   *
   * @param peerId
   * @param value
   */
  update({ peerId, value }: { peerId: PeerId; value: Partial<State> }) {
    const peerState = this.#peerStates.value[peerId]
    const existingState = peerState?.value ?? ({} as State)
    const now = Date.now()
    this.#peerStates = new PeerStateView<State>({
      ...this.#peerStates.value,
      [peerId]: {
        peerId,
        lastSeenAt: now,
        lastActiveAt: now,
        value: {
          ...existingState,
          ...value,
        },
      },
    })
  }

  /**
   * Forget the given peer.
   *
   * @param peerId
   */
  delete(peerId: PeerId) {
    this.#peerStates = new PeerStateView<State>(
      Object.fromEntries(
        Object.entries(this.#peerStates.value).filter(([existingId]) => {
          return existingId != peerId
        })
      )
    )
  }

  /**
   * Prune all peers that have not been seen since the configured ttl has
   * elapsed.
   */
  prune() {
    const threshold = Date.now() - this.ttl
    const pruned: PeerId[] = []
    this.#peerStates = new PeerStateView<State>(
      Object.fromEntries(
        Object.entries(this.#peerStates.value).filter(([id, state]) => {
          const keep = state.lastSeenAt >= threshold
          if (!keep) {
            pruned.push(id as PeerId)
          }
          return keep
        })
      )
    )
    return pruned
  }

  /**
   * Get a snapshot of the current peer states
   */
  get states() {
    return this.#peerStates
  }
}
