import { DocHandle } from "./DocHandle.js"
import { PeerId } from "./types.js"
import { EventEmitter } from "eventemitter3"

type UserId = unknown
type DeviceId = unknown

type PresenceMessageBase = {
  deviceId: DeviceId
  userId: UserId
}

export type PeerState<State> = {
  peerId: PeerId
  deviceId: DeviceId
  userId: UserId
  value: State
}

export type LocalState<State> = Omit<PeerState<State>, "peerId">

export type PresenceMessageState<State = any> = PresenceMessageBase & {
  type: "state"
  value: State
}

export type PresenceMessageHeartbeat = PresenceMessageBase & {
  type: "heartbeat"
}

export type PresenceMessageGoodbye = PresenceMessageBase & {
  type: "goodbye"
}

export type PresenceMessage<State = any> =
  | PresenceMessageState<State>
  | PresenceMessageHeartbeat
  | PresenceMessageGoodbye

export type PresenceMessageType = PresenceMessage["type"]

export type PresenceEvents<State = any> = {
  state: (peerId: PeerId, msg: PresenceMessageState<State>) => void
  heartbeat: (peerId: PeerId, msg: PresenceMessageHeartbeat) => void
  goodbye: (peerId: PeerId, msg: PresenceMessageGoodbye) => void
}

export type PresenceOpts = {
  heartbeatMs?: number
  peerTtlMs?: number
}

export const HEARTBEAT_INTERVAL_MS = 15000
export const PEER_TTL_MS = 1000 * 60 * 60 * 24

export class Presence<
  State,
  Channel extends keyof State
> extends EventEmitter<PresenceEvents> {
  private peerStates: PeerPresences<State>
  private localState: LocalState<State>

  private heartbeatInterval: ReturnType<typeof setInterval> | undefined
  private opts: PresenceOpts = {}

  constructor(
    private handle: DocHandle<unknown>,
    readonly userId: UserId,
    readonly deviceId: DeviceId,
    initialState: State,
    opts?: PresenceOpts
  ) {
    super()
    if (opts) {
      this.opts = opts
    }
    this.peerStates = new PeerPresences(opts?.peerTtlMs ?? PEER_TTL_MS)
    this.localState = {
      userId,
      deviceId,
      value: initialState,
    }

    this.handle.on("ephemeral-message", e => {
      const peerId = e.senderId
      const message = e.message as PresenceMessage<State>
      const { deviceId, userId } = message

      if (!this.peerStates.has(peerId)) {
        // introduce ourselves
        this.broadcastLocalState()
      }

      switch (message.type) {
        case "heartbeat":
          this.peerStates.markSeen(peerId, deviceId, userId)
          this.emit("heartbeat", peerId, {
            type: "heartbeat",
            deviceId: message.deviceId,
            userId: message.userId,
          })
          break
        case "goodbye":
          this.peerStates.delete(peerId)
          this.emit("goodbye", peerId, {
            type: "goodbye",
            deviceId: message.deviceId,
            userId: message.userId,
          })
          break
        case "state":
          const { value } = message
          this.peerStates.update(peerId, deviceId, userId, value)
          this.emit("state", peerId, {
            type: "state",
            deviceId,
            userId,
            value,
          })
          break
      }
    })
    this.broadcastLocalState()
  }

  getPeerStates() {
    // TODO: expose just a read-only view
    return this.peerStates
  }

  getLocalState() {
    // TODO: expose just a read-only view
    return this.localState
  }

  broadcast(channel: Channel, msg: State[Channel]) {
    this.localState.value = {
      ...this.localState.value,
      [channel]: msg,
    }
    this.broadcastLocalState()
  }

  dispose() {
    this.handle.off("ephemeral-message")
    this.stopHeartbeats()
    this.handle.broadcast({
      userId: this.localState.userId,
      deviceId: this.localState.deviceId,
      type: "goodbye",
    })
  }

  private broadcastLocalState() {
    this.handle.broadcast({
      userId: this.localState.userId,
      deviceId: this.localState.deviceId,
      type: "state",
      value: this.localState.value,
    })
    // Reset heartbeats every time we broadcast a message to avoid sending
    // unnecessary heartbeats when there is plenty of actual update activity
    // happening.
    this.stopHeartbeats()
    this.startHeartbeats()
  }

  private sendHeartbeat() {
    this.handle.broadcast({
      userId: this.localState.userId,
      deviceId: this.localState.deviceId,
      type: "heartbeat",
    })
  }

  private startHeartbeats() {
    const heartbeatMs = this.opts.heartbeatMs ?? HEARTBEAT_INTERVAL_MS
    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat()
    }, heartbeatMs)
  }

  private stopHeartbeats() {
    clearInterval(this.heartbeatInterval)
  }
}

export type PeerPresenceStates<State> = Omit<
  PeerPresences<State>,
  "markSeen" | "update" | "prunePeers" | "delete"
>

export class PeerPresences<State> extends EventEmitter<PresenceEvents> {
  private peersLastSeen = new Map<PeerId, number>()
  private peerStates = new Map<PeerId, PeerState<State>>()
  private userPeers = new Map<UserId, Set<PeerId>>()
  private devicePeers = new Map<DeviceId, Set<PeerId>>()

  /**
   * Build a new peer presence state.
   *
   * @param ttl in milliseconds - peers with no activity within this timeframe are forgotten
   */
  constructor(private ttl: number) {
    super()
  }

  markSeen(peerId: PeerId, deviceId: DeviceId, userId: UserId) {
    let devicePeers = this.devicePeers.get(deviceId) ?? new Set<PeerId>()
    devicePeers.add(peerId)
    this.devicePeers.set(deviceId, devicePeers)

    let userPeers = this.userPeers.get(userId) ?? new Set<PeerId>()
    userPeers.add(peerId)
    this.userPeers.set(userId, userPeers)

    this.peersLastSeen.set(peerId, Date.now())
    this.prunePeers()
  }

  update(peerId: PeerId, deviceId: DeviceId, userId: UserId, value: State) {
    this.markSeen(peerId, deviceId, userId)
    this.peerStates.set(peerId, {
      peerId,
      deviceId,
      userId,
      value,
    })
  }

  delete(peerId: PeerId) {
    this.peersLastSeen.delete(peerId)
    this.peerStates.delete(peerId)

    Array.from(this.devicePeers.entries()).forEach(([deviceId, peerIds]) => {
      if (peerIds.has(peerId)) {
        peerIds.delete(peerId)
      }
      if (peerIds.size === 0) {
        this.devicePeers.delete(deviceId)
      }
    })
    Array.from(this.userPeers.entries()).forEach(([userId, peerIds]) => {
      if (peerIds.has(peerId)) {
        peerIds.delete(peerId)
      }
      if (peerIds.size === 0) {
        this.userPeers.delete(userId)
      }
    })
  }

  prunePeers() {
    const threshold = Date.now() - this.ttl
    const stalePeers = new Set(
      Array.from(this.peersLastSeen.entries())
        .filter(([, lastSeen]) => {
          return lastSeen < threshold
        })
        .map(([peerId]) => peerId)
    )
    stalePeers.forEach(stalePeer => {
      this.delete(stalePeer)
    })
  }

  has(peerId: PeerId) {
    return this.peersLastSeen.has(peerId)
  }

  getLastSeen(peerId: PeerId) {
    return this.peersLastSeen.get(peerId)
  }

  getPeers() {
    this.prunePeers()
    return Array.from(this.peersLastSeen.keys())
  }

  getUsers() {
    this.prunePeers()
    return Array.from(this.userPeers.keys())
  }

  getDevices() {
    this.prunePeers()
    return Array.from(this.devicePeers.keys())
  }

  getFreshestPeer(peers: Set<PeerId>) {
    let freshestLastSeen: number
    return Array.from(peers).reduce((freshest: PeerId | undefined, curr) => {
      const lastSeen = this.peersLastSeen.get(curr)
      if (!lastSeen) {
        return freshest
      }

      if (!freshest || lastSeen > freshestLastSeen) {
        freshestLastSeen = lastSeen
        return curr
      }

      return freshest
    }, undefined)
  }

  getPeerDetails(peerId: PeerId) {
    return this.peerStates.get(peerId)
  }

  getPeerState<Channel extends keyof State>(peerId: PeerId, channel?: Channel) {
    const fullState = this.peerStates.get(peerId)?.value
    if (!channel) {
      return fullState
    }

    return fullState?.[channel]
  }

  getUserState<Channel extends keyof State>(userId: UserId, channel?: Channel) {
    const peers = this.userPeers.get(userId)
    if (!peers) {
      return undefined
    }
    const peer = this.getFreshestPeer(peers)
    if (!peer) {
      return undefined
    }

    return this.getPeerState(peer, channel)
  }

  getDeviceState<Channel extends keyof State>(
    deviceId: UserId,
    channel?: Channel
  ) {
    const peers = this.devicePeers.get(deviceId)
    if (!peers) {
      return undefined
    }
    const peer = this.getFreshestPeer(peers)
    if (!peer) {
      return undefined
    }

    return this.getPeerState(peer, channel)
  }
}
