import { DocHandle, DocHandleEphemeralMessagePayload } from "./DocHandle.js"
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

export type PresenceEventState<State> = PresenceMessageState<State> & { peerId: PeerId }
export type PresenceEventHeartbeat = PresenceMessageHeartbeat & { peerId: PeerId }
export type PresenceEventGoodbye = PresenceMessageGoodbye & { peerId: PeerId }

export type PresenceEvents<State = any> = {
  state: (msg: PresenceEventState<State>) => void
  heartbeat: (msg: PresenceEventHeartbeat) => void
  goodbye: (msg: PresenceEventGoodbye) => void
}

export type PresenceOpts = {
  heartbeatMs?: number
  peerTtlMs?: number
  skipAutoInit?: boolean
}

export const HEARTBEAT_INTERVAL_MS = 15000
export const PEER_TTL_MS = 1000 * 60 * 60 * 24

let num = 0;

export class Presence<
  State,
  Channel extends keyof State
> extends EventEmitter<PresenceEvents> {
  private peers: PresencePeers<State>
  private localState: LocalState<State>
  private handleEphemeralMessage: ((e: DocHandleEphemeralMessagePayload<unknown>) => void) | undefined

  private heartbeatInterval: ReturnType<typeof setInterval> | undefined
  private opts: PresenceOpts = {}
  private hellos: ReturnType<typeof setTimeout>[] = []

  //debugging
  public seen: DocHandleEphemeralMessagePayload<unknown>[] = []
  public disposed = false
  public name: string;

  constructor(
    private handle: DocHandle<unknown>,
    readonly userId: UserId,
    readonly deviceId: DeviceId,
    initialState: State,
    opts?: PresenceOpts
  ) {
    super()
    this.name = `pres-${num++}`
    console.log("constructing", this.name)
    if (opts) {
      this.opts = opts
    }
    this.peers = new PresencePeers(opts?.peerTtlMs ?? PEER_TTL_MS)
    this.localState = {
      userId,
      deviceId,
      value: initialState,
    }
    if (opts?.skipAutoInit) {
      return
    }
    this.initialize()
  }

  initialize() {
    console.log("initializing", this.name)
    if (this.handleEphemeralMessage && !this.disposed) {
      return
    }
    // N.B.: We can't use a regular member function here since member functions
    // of two distinct objects are identical, and we need to be able to stop
    // listening to the handle for just this Presence instance in dispose()
    this.handleEphemeralMessage = (e: DocHandleEphemeralMessagePayload<unknown>) => {
      this.seen.push(e)
      console.log(new Date().toISOString(), this.name, "handling", (e.message as any).type, "from", e.senderId)
      const peerId = e.senderId
      const message = e.message as PresenceMessage<State>
      const { deviceId, userId } = message

      if (!this.peers.has(peerId)) {
        this.announce()
      }

      switch (message.type) {
        case "heartbeat":
          this.peers.markSeen(peerId, deviceId, userId)
          this.emit("heartbeat", {
            peerId,
            type: "heartbeat",
            deviceId,
            userId,
          })
          break
        case "goodbye":
          this.peers.delete(peerId)
          this.emit("goodbye", {
            peerId,
            type: "goodbye",
            deviceId,
            userId,
          })
          break
        case "state":
          const { value } = message
          this.peers.update(peerId, deviceId, userId, value)
          this.emit("state", {
            peerId,
            type: "state",
            deviceId,
            userId,
            value,
          })
          break
      }
    }
    this.handle.on("ephemeral-message", this.handleEphemeralMessage)

    this.broadcastLocalState()
  }

  getPeerStates() {
    // TODO: expose just a read-only view
    return this.peers
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
    if (this.disposed) {
      return
    }
    this.hellos.forEach((timeoutId) => {
      clearTimeout(timeoutId)
    })
    this.hellos = []
    this.handle.off("ephemeral-message", this.handleEphemeralMessage)
    this.stopHeartbeats()
    this.doBroadcast("goodbye")
    this.disposed = true
  }

  private announce() {
    // Broadcast our current state whenever we see new peers
    // TODO: We currently need to wait for the peer to be ready, but waiting
    // some arbitrary amount of time is brittle
    const helloId = setTimeout(() => {
      this.broadcastLocalState()
      this.hellos = this.hellos.filter((id) => id !== helloId)
    }, 500)
    this.hellos.push(helloId)
  }

  private broadcastLocalState() {
    this.doBroadcast("state", { value: this.localState.value })
    // Reset heartbeats every time we broadcast a message to avoid sending
    // unnecessary heartbeats when there is plenty of actual update activity
    // happening.
    this.stopHeartbeats()
    this.startHeartbeats()
  }

  private sendHeartbeat() {
    this.doBroadcast("heartbeat")
  }

  private doBroadcast(type: PresenceMessageType, extra?: Record<string,unknown>) {
    console.log(new Date().toISOString(), this.name, "broadcasting", type)
    const { userId, deviceId } = this.localState
    this.handle.broadcast({
      userId,
      deviceId,
      type,
      ...extra
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

export type PresencePeerStates<State> = Omit<
  PresencePeers<State>,
  "markSeen" | "update" | "prunePeers" | "delete"
>

export class PresencePeers<State> extends EventEmitter<PresenceEvents> {
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
  }

  update(peerId: PeerId, deviceId: DeviceId, userId: UserId, value: State) {
    this.markSeen(peerId, deviceId, userId)
    this.peerStates.set(peerId, {
      peerId,
      deviceId,
      userId,
      value,
    })
    this.prune()
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

  prune() {
    const threshold = Date.now() - this.ttl
    const stalePeers = new Set(
      Array.from(this.peersLastSeen.entries())
        .filter(([, lastSeen]) => {
          return lastSeen < threshold
        })
        .map(([peerId]) => peerId)
    )
    if (stalePeers.size === 0) {
      return
    }
    console.log("pruning stale peers", Array.from(stalePeers))
    stalePeers.forEach(stalePeer => {
      this.delete(stalePeer)
    })
  }

  has(peerId: PeerId) {
    return this.peerStates.has(peerId)
  }

  getLastSeen(peerId: PeerId) {
    return this.peersLastSeen.get(peerId)
  }

  getPeers() {
    this.prune()
    return Array.from(this.peerStates.keys())
  }

  getUsers() {
    this.prune()
    return Array.from(this.userPeers.keys())
  }

  getDevices() {
    this.prune()
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
