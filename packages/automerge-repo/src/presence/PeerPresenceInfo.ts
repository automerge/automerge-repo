import { RepoId, PeerId } from "../types.js"
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

  has(originId: RepoId) {
    return originId in this.#peerStates.value
  }

  /**
   * Record that we've seen the given peer recently.
   *
   * @param originId
   */
  markSeen(originId: RepoId) {
    if (!(originId in this.#peerStates.value)) {
      // Ignore heartbeats from peers we have not seen before: they will send a snapshot
      return
    }
    this.#peerStates = new PeerStateView<State>({
      ...this.#peerStates.value,
      [originId]: {
        ...this.#peerStates.value[originId],
        lastSeenAt: Date.now(),
      },
    })
  }

  /**
   * Record a state update for the given peer. Note that existing state is not
   * overwritten.
   *
   * @param senderId
   * @param originId
   * @param value
   */
  update({
    senderId,
    originId,
    value,
  }: {
    senderId: PeerId
    originId: RepoId
    value: Partial<State>
  }) {
    const peerState = this.#peerStates.value[originId]
    const existingState = peerState?.value ?? ({} as State)
    const now = Date.now()
    this.#peerStates = new PeerStateView<State>({
      ...this.#peerStates.value,
      [originId]: {
        senderId,
        originId,
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
   * @param originId
   */
  delete(originId: RepoId) {
    this.#peerStates = new PeerStateView<State>(
      Object.fromEntries(
        Object.entries(this.#peerStates.value).filter(([existingId]) => {
          return existingId != originId
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
    const pruned: RepoId[] = []
    this.#peerStates = new PeerStateView<State>(
      Object.fromEntries(
        Object.entries(this.#peerStates.value).filter(([id, state]) => {
          const keep = state.lastSeenAt >= threshold
          if (!keep) {
            pruned.push(id as RepoId)
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
