import { unique } from "../helpers/array.js"
import { PeerId } from "../types.js"
import { DeviceId, PeerStatesValue, PresenceState, UserId } from "./types.js"

export class PeerStateView<State extends PresenceState> {
  readonly value

  constructor(value: PeerStatesValue<State>) {
    this.value = value
  }

  /**
   * Get all users.
   *
   * @returns Array of user presence {@link State}s
   */
  get users() {
    const userIds = unique(
      Object.values(this.value).map(peerState => peerState.userId)
    )
    return userIds.map(u => this.getUserState(u))
  }

  /**
   * Get all devices.
   *
   * @returns Array of device presence {@link State}s
   */
  get devices() {
    const deviceIds = unique(
      Object.values(this.value).map(peerState => peerState.deviceId)
    )
    return deviceIds.map(d => this.getDeviceState(d))
  }

  /**
   * Get all peers.
   *
   * @returns Array of peer presence {@link State}s
   */
  get peers() {
    return Object.values(this.value)
  }

  /**
   * Get all peer ids for this user.
   *
   * @param userId
   * @returns Array of peer ids for this user
   */
  getUserPeers(userId: UserId) {
    return Object.values(this.value)
      .filter(peerState => peerState.userId === userId)
      .map(peerState => peerState.peerId)
  }

  /**
   * Get all peers for this device.
   *
   * @param deviceId
   * @returns Array of peer ids for this device
   */
  getDevicePeers(deviceId: DeviceId) {
    return Object.values(this.value)
      .filter(peerState => peerState.deviceId === deviceId)
      .map(peerState => peerState.peerId)
  }

  /**
   * Return the most-recently-seen peer from this group.
   *
   * @param peers
   * @returns id of most recently seen peer
   */
  getLastSeenPeer(peers: PeerId[]) {
    let freshestLastSeenAt: number
    return peers.reduce((freshest: PeerId | undefined, curr) => {
      const lastSeenAt = this.value[curr]?.lastSeenAt
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

  /**
   * Return the peer from this group that sent a state update most recently
   *
   * @param peers
   * @returns id of most recently seen peer
   */
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

  /**
   * Get current ephemeral state value for this user's most-recently-active
   * peer.
   *
   * @param userId
   * @returns user's {@link State}
   */
  getUserState(userId: UserId) {
    const peers = this.getUserPeers(userId)
    if (!peers) {
      return undefined
    }
    const peer = this.getLastActivePeer(peers)
    if (!peer) {
      return undefined
    }

    return this.value[peer]
  }

  /**
   * Get current ephemeral state value for this device's most-recently-active
   * peer.
   *
   * @param deviceId
   * @returns device's {@link State}
   */
  getDeviceState(deviceId: DeviceId) {
    const peers = this.getDevicePeers(deviceId)
    if (!peers) {
      return undefined
    }
    const peer = this.getLastActivePeer(peers)
    if (!peer) {
      return undefined
    }

    return this.value[peer]
  }
}
