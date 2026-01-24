import { PeerId } from "../types.js"
import { PeerStateView } from "./PeerStateView.js"
import { DeviceId, PresenceState, UserId } from "./types.js"

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
    this.#peerStates = new PeerStateView<State>({
      ...this.#peerStates.value,
      [peerId]: {
        ...this.#peerStates.value[peerId],
        peerId,
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
  update({
    peerId,
    deviceId,
    userId,
    value,
  }: {
    peerId: PeerId
    deviceId?: DeviceId
    userId?: UserId
    value: Partial<State>
  }) {
    const peerState = this.#peerStates.value[peerId]
    const existingState = peerState?.value ?? ({} as State)
    const now = Date.now()
    this.#peerStates = new PeerStateView<State>({
      ...this.#peerStates.value,
      [peerId]: {
        peerId,
        deviceId,
        userId,
        lastActiveAt: now,
        lastSeenAt: now,
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
    this.#peerStates = new PeerStateView<State>(
      Object.fromEntries(
        Object.entries(this.#peerStates.value).filter(([, state]) => {
          return state.lastSeenAt >= threshold
        })
      )
    )
  }

  /**
   * Get a snapshot of the current peer states
   */
  get states() {
    return this.#peerStates
  }
}
