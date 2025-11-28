import { DocHandle, DocHandleEphemeralMessagePayload } from "./DocHandle.js"
import { PeerId } from "./types.js"
import { EventEmitter } from "eventemitter3"

type UserId = unknown
type DeviceId = unknown

export type PeerState<State> = {
  peerId: PeerId
  deviceId: DeviceId
  userId: UserId
  value: State
}

type PresenceMessageBase = {
  deviceId: DeviceId
  userId: UserId
}

type PresenceMessageState<State = any> = PresenceMessageBase & {
  type: "state"
  value: State
}

type PresenceMessageHeartbeat = PresenceMessageBase & {
  type: "heartbeat"
}

type PresenceMessageGoodbye = PresenceMessageBase & {
  type: "goodbye"
}

type PresenceMessage<State = any> =
  | PresenceMessageState<State>
  | PresenceMessageHeartbeat
  | PresenceMessageGoodbye

type PresenceMessageType = PresenceMessage["type"]

type WithPeerId = { peerId: PeerId }

export type PresenceEventState<State> = PresenceMessageState<State> & WithPeerId
export type PresenceEventHeartbeat = PresenceMessageHeartbeat & WithPeerId
export type PresenceEventGoodbye = PresenceMessageGoodbye & WithPeerId

/**
 * Events emitted by Presence when ephemeral messages are received from peers.
 */
export type PresenceEvents<State = any> = {
  /**
   * Handle a state update broadcast by a peer.
   */
  state: (msg: PresenceEventState<State>) => void
  /**
   * Handle a heartbeat broadcast by a peer.
   */
  heartbeat: (msg: PresenceEventHeartbeat) => void
  /**
   * Handle a disconnection broadcast by a peer.
   */
  goodbye: (msg: PresenceEventGoodbye) => void
}

export type PresenceOpts = {
  /** How frequently to send heartbeats */
  heartbeatMs?: number
  /** How long to wait until forgetting peers with no activity */
  peerTtlMs?: number
  /** Whether to skip automatic initialization (if so, {@link Presence.start} must be called manually.) */
  skipAutoInit?: boolean
}

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000
export const DEFAULT_PEER_TTL_MS = 3 * DEFAULT_HEARTBEAT_INTERVAL_MS

/**
 * Presence encapsulates ephemeral state communication for a specific doc
 * handle. It tracks caller-provided local state and broadcasts that state to
 * all peers. It sends periodic heartbeats when there are no state updates.
 *
 * It also tracks ephemeral state broadcast by peers and emits events when
 * peers send ephemeral state updates (see {@link PresenceEvents}).
 */
export class Presence<
  State
> extends EventEmitter<PresenceEvents> {
  #handle: DocHandle<unknown>
  #peers: PeerPresenceInfo<State>
  #localState: State
  #handleEphemeralMessage:
    | ((e: DocHandleEphemeralMessagePayload<unknown>) => void)
    | undefined

  #heartbeatInterval: ReturnType<typeof setInterval> | undefined
  #opts: PresenceOpts = {}
  #hellos: ReturnType<typeof setTimeout>[] = []

  #running = false

  /**
   * Create a new Presence to share ephemeral state with peers.
   *
   * @param handle - doc handle to use
   * @param userId - our user id (this is unverified; peers can send anything)
   * @param deviceId - our device id (like userId, this is unverified)
   * @param initialState - the full initial state to broadcast to peers
   * @param opts - see {@link PresenceOpts}
   * @returns
   */
  constructor(
    handle: DocHandle<unknown>,
    readonly userId: UserId,
    readonly deviceId: DeviceId,
    initialState: State,
    opts?: PresenceOpts
  ) {
    super()
    if (opts) {
      this.#opts = opts
    }
    this.#handle = handle

    this.#localState = initialState
    this.#peers = new PeerPresenceInfo(opts?.peerTtlMs ?? DEFAULT_PEER_TTL_MS)

    if (opts?.skipAutoInit) {
      return
    }
    this.start()
  }

  /**
   * Start listening to ephemeral messages on the handle, broadcast initial
   * state to peers, and start sending heartbeats.
   */
  start() {
    if (this.#running) {
      return
    }
    // N.B.: We can't use a regular member function here since member functions
    // of two distinct objects are identical, and we need to be able to stop
    // listening to the handle for just this Presence instance in stop()
    this.#handleEphemeralMessage = (
      e: DocHandleEphemeralMessagePayload<unknown>
    ) => {
      const peerId = e.senderId
      const message = e.message as PresenceMessage<State>
      const { deviceId, userId } = message

      if (!this.#peers.view.has(peerId)) {
        this.announce()
      }

      switch (message.type) {
        case "heartbeat":
          this.#peers.markSeen(peerId, deviceId, userId)
          this.emit("heartbeat", {
            peerId,
            type: "heartbeat",
            deviceId,
            userId,
          })
          break
        case "goodbye":
          this.#peers.delete(peerId)
          this.emit("goodbye", {
            peerId,
            type: "goodbye",
            deviceId,
            userId,
          })
          break
        case "state":
          const { value } = message
          this.#peers.update(peerId, deviceId, userId, value)
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
    this.#handle.on("ephemeral-message", this.#handleEphemeralMessage)

    this.broadcastLocalState()
    this.#running = true
  }

  /**
   * Return a view of current peer states.
   */
  getPeerStates() {
    return this.#peers.view
  }

  /**
   * Return a view of current local state.
   */
  getLocalState() {
    return { ...this.#localState }
  }

  /**
   * Update state for the specific channel, and broadcast new state to all
   * peers.
   *
   * @param channel
   * @param msg
   */
  broadcast<Channel extends keyof State>(channel: Channel, msg: State[Channel]) {
    this.#localState = {
      ...this.#localState,
      [channel]: msg,
    }
    this.broadcastLocalState()
  }

  /**
   * Whether this Presence is currently active. See
   * {@link start} and {@link stop}.
   */
  get running() {
    return this.#running
  }

  /**
   * Stop this Presence: broadcast a "goodbye" message (when received, other
   * peers will immediately forget the sender), stop sending heartbeats, and
   * stop listening to ephemeral-messages broadcast from peers.
   *
   * This can be used with browser events like
   * {@link https://developer.mozilla.org/en-US/docs/Web/API/Window/pagehide_event | "pagehide"}
   * or
   * {@link https://developer.mozilla.org/en-US/docs/Web/API/Document/visibilitychange_event | "visibilitychange"}
   * to stop sending and receiving updates when not active.
   */
  stop() {
    if (!this.#running) {
      return
    }
    this.#hellos.forEach(timeoutId => {
      clearTimeout(timeoutId)
    })
    this.#hellos = []
    this.#handle.off("ephemeral-message", this.#handleEphemeralMessage)
    this.stopHeartbeats()
    this.doBroadcast("goodbye")
    this.#running = false
  }

  private announce() {
    // Broadcast our current state whenever we see new peers
    // TODO: We currently need to wait for the peer to be ready, but waiting
    // some arbitrary amount of time is brittle
    const helloId = setTimeout(() => {
      this.broadcastLocalState()
      this.#hellos = this.#hellos.filter(id => id !== helloId)
    }, 500)
    this.#hellos.push(helloId)
  }

  private broadcastLocalState() {
    this.doBroadcast("state", { value: this.#localState })
    // Reset heartbeats every time we broadcast a message to avoid sending
    // unnecessary heartbeats when there is plenty of actual update activity
    // happening.
    this.stopHeartbeats()
    this.startHeartbeats()
  }

  private sendHeartbeat() {
    this.doBroadcast("heartbeat")
  }

  private doBroadcast(
    type: PresenceMessageType,
    extra?: Record<string, unknown>
  ) {
    this.#handle.broadcast({
      userId: this.userId,
      deviceId: this.deviceId,
      type,
      ...extra,
    })
  }

  private startHeartbeats() {
    const heartbeatMs = this.#opts.heartbeatMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
    this.#heartbeatInterval = setInterval(() => {
      this.sendHeartbeat()
      this.#peers.prune()
    }, heartbeatMs)
  }

  private stopHeartbeats() {
    clearInterval(this.#heartbeatInterval)
  }
}

/**
 * A summary of the latest Presence information for the set of peers who have
 * reported a Presence status to us.
 */
export class PeerPresenceView<State> {
  #peersLastSeen = new Map<PeerId, number>()
  #peerStates = new Map<PeerId, PeerState<State>>()
  #userPeers = new Map<UserId, Set<PeerId>>()
  #devicePeers = new Map<DeviceId, Set<PeerId>>()

  /** @hidden */
  constructor(
    peersLastSeen: Map<PeerId, number>,
    peerStates: Map<PeerId, PeerState<State>>,
    userPeers: Map<UserId, Set<PeerId>>,
    devicePeers: Map<DeviceId, Set<PeerId>>
  ) {
    this.#peersLastSeen = peersLastSeen
    this.#peerStates = peerStates
    this.#userPeers = userPeers
    this.#devicePeers = devicePeers
  }

  /**
   * Check if peer is currently present.
   *
   * @param peerId
   * @returns true if the peer has been seen recently
   */
  has(peerId: PeerId) {
    return this.#peerStates.has(peerId)
  }

  /**
   * Check when the peer was last seen.
   *
   * @param peerId
   * @returns last seen UNIX timestamp, or undefined for unknown peers
   */
  getLastSeen(peerId: PeerId) {
    return this.#peersLastSeen.get(peerId)
  }

  /**
   * Get all recently-seen peers.
   *
   * @returns Array of peer ids
   */
  getPeers() {
    return Array.from(this.#peerStates.keys())
  }

  /**
   * Get all recently-seen users.
   *
   * @returns Array of user ids
   */
  getUsers() {
    return Array.from(this.#userPeers.keys())
  }

  /**
   * Get all recently-seen devices.
   *
   * @returns Array of device ids
   */
  getDevices() {
    return Array.from(this.#devicePeers.keys())
  }

  /**
   * Get all recently-seen peers for this user.
   *
   * @param userId
   * @returns Array of peer ids for this user
   */
  getUserPeers(userId: UserId) {
    const peers = this.#userPeers.get(userId)
    if (!peers) {
      return
    }
    return Array.from(peers)
  }

  /**
   * Get all recently-seen peers for this device.
   *
   * @param deviceId
   * @returns Array of peer ids for this device
   */
  getDevicePeers(deviceId: DeviceId) {
    const peers = this.#devicePeers.get(deviceId)
    if (!peers) {
      return
    }
    return Array.from(peers)
  }

  /**
   * Get most-recently-seen peer from this group.
   *
   * @param peers
   * @returns id of most recently seen peer
   */
  getFreshestPeer(peers: Set<PeerId>) {
    let freshestLastSeen: number
    return Array.from(peers).reduce((freshest: PeerId | undefined, curr) => {
      const lastSeen = this.#peersLastSeen.get(curr)
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

  /**
   * Get current @type PeerState for given peer.
   *
   * @param peerId
   * @returns details for the peer
   */
  getPeerInfo(peerId: PeerId) {
    return this.#peerStates.get(peerId)
  }

  /**
   * Get current ephemeral state value for this peer. If a channel is specified,
   * only returns the ephemeral state for that specific channel. Otherwise,
   * returns the full ephemeral state.
   *
   * @param peerId
   * @param channel
   * @returns latest ephemeral state received
   */
  getPeerState<Channel extends keyof State>(peerId: PeerId, channel?: Channel) {
    const fullState = this.#peerStates.get(peerId)?.value
    if (!channel) {
      return fullState
    }

    return fullState?.[channel]
  }

  /**
   * Get current ephemeral state value for this user's most-recently-active
   * peer. See {@link getPeerState}.
   *
   * @param userId
   * @param channel
   * @returns
   */
  getUserState<Channel extends keyof State>(userId: UserId, channel?: Channel) {
    const peers = this.#userPeers.get(userId)
    if (!peers) {
      return undefined
    }
    const peer = this.getFreshestPeer(peers)
    if (!peer) {
      return undefined
    }

    return this.getPeerState(peer, channel)
  }

  /**
   * Get current ephemeral state value for this device's most-recently-active
   * peer. See {@link getPeerState}.
   *
   * @param userId
   * @param channel
   * @returns
   */
  getDeviceState<Channel extends keyof State>(
    deviceId: UserId,
    channel?: Channel
  ) {
    const peers = this.#devicePeers.get(deviceId)
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

class PeerPresenceInfo<State> extends EventEmitter<PresenceEvents> {
  #peersLastSeen = new Map<PeerId, number>()
  #peerStates = new Map<PeerId, PeerState<State>>()
  #userPeers = new Map<UserId, Set<PeerId>>()
  #devicePeers = new Map<DeviceId, Set<PeerId>>()

  readonly view: PeerPresenceView<State>

  /**
   * Build a new peer presence state.
   *
   * @param ttl in milliseconds - peers with no activity within this timeframe
   * are forgotten when {@link prune} is called.
   */
  constructor(readonly ttl: number) {
    super()
    this.view = new PeerPresenceView(
      this.#peersLastSeen,
      this.#peerStates,
      this.#userPeers,
      this.#devicePeers
    )
  }

  /**
   * Record that we've seen the given peer recently.
   *
   * @param peerId
   * @param deviceId
   * @param userId
   */
  markSeen(peerId: PeerId, deviceId: DeviceId, userId: UserId) {
    let devicePeers = this.#devicePeers.get(deviceId) ?? new Set<PeerId>()
    devicePeers.add(peerId)
    this.#devicePeers.set(deviceId, devicePeers)

    let userPeers = this.#userPeers.get(userId) ?? new Set<PeerId>()
    userPeers.add(peerId)
    this.#userPeers.set(userId, userPeers)

    this.#peersLastSeen.set(peerId, Date.now())
  }

  /**
   * Record a state update for the given peer. It is also automatically updated with {@link markSeen}.
   *
   * @param peerId
   * @param deviceId
   * @param userId
   * @param value
   */
  update(peerId: PeerId, deviceId: DeviceId, userId: UserId, value: State) {
    this.markSeen(peerId, deviceId, userId)
    this.#peerStates.set(peerId, {
      peerId,
      deviceId,
      userId,
      value,
    })
  }

  /**
   * Forget the given peer.
   *
   * @param peerId
   */
  delete(peerId: PeerId) {
    this.#peersLastSeen.delete(peerId)
    this.#peerStates.delete(peerId)

    Array.from(this.#devicePeers.entries()).forEach(([deviceId, peerIds]) => {
      if (peerIds.has(peerId)) {
        peerIds.delete(peerId)
      }
      if (peerIds.size === 0) {
        this.#devicePeers.delete(deviceId)
      }
    })
    Array.from(this.#userPeers.entries()).forEach(([userId, peerIds]) => {
      if (peerIds.has(peerId)) {
        peerIds.delete(peerId)
      }
      if (peerIds.size === 0) {
        this.#userPeers.delete(userId)
      }
    })
  }

  /**
   * Prune all peers that have not been seen since the configured ttl has
   * elapsed.
   */
  prune() {
    const threshold = Date.now() - this.ttl
    const stalePeers = new Set(
      Array.from(this.#peersLastSeen.entries())
        .filter(([, lastSeen]) => {
          return lastSeen < threshold
        })
        .map(([peerId]) => peerId)
    )
    if (stalePeers.size === 0) {
      return
    }
    stalePeers.forEach(stalePeer => {
      this.delete(stalePeer)
    })
  }
}
