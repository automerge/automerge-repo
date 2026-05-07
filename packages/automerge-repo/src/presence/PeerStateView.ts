import { unique } from "../helpers/array.js"
import { PeerId } from "../types.js"
import { DeviceId, PeerStatesValue, PresenceState, UserId } from "./types.js"

export class PeerStateView<State extends PresenceState> {
  readonly value

  constructor(value: PeerStatesValue<State>) {
    this.value = value
  }

  /** All distinct users across peers. */
  get users() {
    const userIds = unique(
      Object.values(this.value).map(peerState => peerState.userId)
    )
    return userIds.map(u => this.getUserState(u))
  }

  /** All distinct devices across peers. */
  get devices() {
    const deviceIds = unique(
      Object.values(this.value).map(peerState => peerState.deviceId)
    )
    return deviceIds.map(d => this.getDeviceState(d))
  }

  /** All peer states. */
  get peers() {
    return Object.values(this.value)
  }

  /** Peer IDs belonging to a given user. */
  getUserPeers(userId: UserId) {
    return Object.values(this.value)
      .filter(peerState => peerState.userId === userId)
      .map(peerState => peerState.peerId)
  }

  /** Peer IDs belonging to a given device. */
  getDevicePeers(deviceId: DeviceId) {
    return Object.values(this.value)
      .filter(peerState => peerState.deviceId === deviceId)
      .map(peerState => peerState.peerId)
  }

  /** Most recently seen peer from a set of peer IDs. */
  getLastSeenPeer(peers: PeerId[]) {
    let freshestLastSeenAt: number
    return peers.reduce((freshest: PeerId | undefined, curr) => {
      const lastSeenAt = this.value[curr]?.lastUpdateAt
      if (!lastSeenAt) {
        return freshest
      }

      if (!freshest || lastSeenAt > freshestLastSeenAt) {
        freshestLastSeenAt = lastSeenAt
        return curr
      }

      return freshest
    }, undefined)
  }

  /** Peer from a set that most recently sent a state update. */
  getLastActivePeer(peers: PeerId[]) {
    let freshestLastActiveAt: number
    return peers.reduce((freshest: PeerId | undefined, curr) => {
      const lastActiveAt = this.value[curr]?.lastActiveAt
      if (!lastActiveAt) {
        return freshest
      }

      if (!freshest || lastActiveAt > freshestLastActiveAt) {
        freshestLastActiveAt = lastActiveAt
        return curr
      }

      return freshest
    }, undefined)
  }

  /** State of the most recently active peer for a user. */
  getUserState(userId: UserId) {
    const peers = this.getUserPeers(userId)
    if (!peers) return undefined

    const peer = this.getLastActivePeer(peers)
    if (!peer) return undefined

    return this.value[peer]
  }

  /** State of the most recently active peer for a device. */
  getDeviceState(deviceId: DeviceId) {
    const peers = this.getDevicePeers(deviceId)
    if (!peers) return undefined

    const peer = this.getLastActivePeer(peers)
    if (!peer) return undefined

    return this.value[peer]
  }
}
