import { DocHandle, DocHandleEphemeralMessagePayload } from "./DocHandle.js"
import { PeerId } from "./types.js"
import { EventEmitter } from "eventemitter3"
import { unique } from "./helpers/array.js"

export type UserId = unknown
export type DeviceId = unknown

export const PRESENCE_MESSAGE_MARKER = "__presence"

export type PresenceState = Record<string, any>

export type PeerStatesValue<State extends PresenceState> = Record<
  PeerId,
  PeerState<State>
>

export type PeerState<State extends PresenceState> = {
  peerId: PeerId
  lastActiveAt: number
  lastUpdateAt: number
  deviceId?: DeviceId
  userId?: UserId
  value: State
}

type PresenceMessageBase = {
  deviceId?: DeviceId
  userId?: UserId
}

type PresenceMessageUpdate = PresenceMessageBase & {
  type: "update"
  channel: string
  value: any
}

type PresenceMessageSnapshot = PresenceMessageBase & {
  type: "snapshot"
  state: any
}

type PresenceMessageHeartbeat = PresenceMessageBase & {
  type: "heartbeat"
}

type PresenceMessageGoodbye = PresenceMessageBase & {
  type: "goodbye"
}

type PresenceMessage = {
  [PRESENCE_MESSAGE_MARKER]:
    | PresenceMessageUpdate
    | PresenceMessageSnapshot
    | PresenceMessageHeartbeat
    | PresenceMessageGoodbye
}

type PresenceMessageType =
  PresenceMessage[typeof PRESENCE_MESSAGE_MARKER]["type"]

type WithPeerId = { peerId: PeerId }

export type PresenceEventUpdate = PresenceMessageUpdate & WithPeerId
export type PresenceEventSnapshot = PresenceMessageSnapshot & WithPeerId
export type PresenceEventHeartbeat = PresenceMessageHeartbeat & WithPeerId
export type PresenceEventGoodbye = PresenceMessageGoodbye & WithPeerId

/**
 * Events emitted by Presence when ephemeral messages are received from peers.
 */
export type PresenceEvents = {
  /**
   * Handle a state update broadcast by a peer.
   */
  update: (msg: PresenceEventUpdate) => void
  /**
   * Handle a full state snapshot broadcast by a peer.
   */
  snapshot: (msg: PresenceEventSnapshot) => void
  /**
   * Handle a heartbeat broadcast by a peer.
   */
  heartbeat: (msg: PresenceEventHeartbeat) => void
  /**
   * Handle a disconnection broadcast by a peer.
   */
  goodbye: (msg: PresenceEventGoodbye) => void
}

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000
export const DEFAULT_PEER_TTL_MS = 3 * DEFAULT_HEARTBEAT_INTERVAL_MS

export type PresenceConfig<State extends PresenceState> = {
  /** The full initial state to broadcast to peers */
  initialState: State
  /** How frequently to send heartbeats (default {@link DEFAULT_HEARTBEAT_INTERVAL_MS}) */
  heartbeatMs?: number
  /** How long to wait until forgetting peers with no activity  (default {@link DEFAULT_PEER_TTL_MS}) */
  peerTtlMs?: number
}

/**
 * Presence encapsulates ephemeral state communication for a specific doc
 * handle. It tracks caller-provided local state and broadcasts that state to
 * all peers. It sends periodic heartbeats when there are no state updates.
 *
 * It also tracks ephemeral state broadcast by peers and emits events when peers
 * send ephemeral state updates (see {@link PresenceEvents}).
 *
 * Presence starts out in an inactive state. Call {@link start} and {@link stop}
 * to activate and deactivate it.
 */
export class Presence<
  State extends PresenceState,
  DocType = any
> extends EventEmitter<PresenceEvents> {
  #handle: DocHandle<DocType>
  readonly deviceId?: DeviceId
  readonly userId?: UserId
  #peers: PeerPresenceInfo<State>
  #localState: State
  #heartbeatMs?: number

  #handleEphemeralMessage:
    | ((e: DocHandleEphemeralMessagePayload<DocType>) => void)
    | undefined

  #heartbeatInterval: ReturnType<typeof setInterval> | undefined
  #pruningInterval: ReturnType<typeof setInterval> | undefined
  #hellos: ReturnType<typeof setTimeout>[] = []

  #running = false

  /**
   * Create a new Presence to share ephemeral state with peers.
   *
   * @param config see {@link PresenceConfig}
   * @returns
   */
  constructor({
    handle,
    deviceId,
    userId,
  }: {
    handle: DocHandle<DocType>
    /** Our device id (like userId, this is unverified; peers can send anything) */
    deviceId?: DeviceId
    /** Our user id (this is unverified; peers can send anything) */
    userId?: UserId
  }) {
    super()
    this.#handle = handle
    this.#peers = new PeerPresenceInfo<State>(DEFAULT_PEER_TTL_MS)
    this.#localState = {} as State
    this.userId = userId
    this.deviceId = deviceId
  }

  /**
   * Start listening to ephemeral messages on the handle, broadcast initial
   * state to peers, and start sending heartbeats.
   */
  start({ initialState, heartbeatMs, peerTtlMs }: PresenceConfig<State>) {
    if (this.#running) {
      return
    }
    this.#running = true

    this.#heartbeatMs = heartbeatMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
    this.#peers = new PeerPresenceInfo<State>(peerTtlMs ?? DEFAULT_PEER_TTL_MS)
    this.#localState = initialState

    // N.B.: We can't use a regular member function here since member functions
    // of two distinct objects are identical, and we need to be able to stop
    // listening to the handle for just this Presence instance in stop()
    this.#handleEphemeralMessage = (
      e: DocHandleEphemeralMessagePayload<DocType>
    ) => {
      const peerId = e.senderId
      const envelope = e.message as PresenceMessage

      if (!(PRESENCE_MESSAGE_MARKER in envelope)) {
        return
      }

      const message = envelope[PRESENCE_MESSAGE_MARKER]
      const { deviceId, userId } = message

      if (!this.#peers.has(peerId)) {
        this.announce()
      }

      switch (message.type) {
        case "heartbeat":
          this.#peers.markSeen(peerId)
          this.emit("heartbeat", { type: "heartbeat", peerId })
          break
        case "goodbye":
          this.#peers.delete(peerId)
          this.emit("goodbye", { type: "goodbye", peerId })
          break
        case "update":
          this.#peers.update({
            peerId,
            deviceId,
            userId,
            value: { [message.channel]: message.value } as Partial<State>,
          })
          this.emit("update", {
            type: "update",
            peerId,
            deviceId,
            userId,
            channel: message.channel,
            value: message.value,
          })
          break
        case "snapshot":
          this.#peers.update({
            peerId,
            deviceId,
            userId,
            value: message.state as State,
          })
          this.emit("snapshot", {
            type: "snapshot",
            peerId,
            deviceId,
            userId,
            state: message.state,
          })
          break
      }
    }
    this.#handle.on("ephemeral-message", this.#handleEphemeralMessage)

    this.broadcastLocalState() // also starts heartbeats
    this.startPruningPeers()
  }

  /**
   * Return a view of current peer states.
   */
  getPeerStates() {
    return this.#peers.states
  }

  /**
   * Return a view of current local state.
   */
  getLocalState() {
    return this.#localState
  }

  /**
   * Update state for the specific channel, and broadcast new state to all
   * peers.
   *
   * @param channel
   * @param value
   */
  broadcast<Channel extends keyof State>(
    channel: Channel,
    value: State[Channel]
  ) {
    this.#localState = Object.assign({}, this.#localState, {
      [channel]: value,
    })
    this.broadcastChannelState(channel)
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
    this.stopPruningPeers()
    this.send({ type: "goodbye" })
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
    this.doBroadcast("snapshot", { state: this.#localState })
    this.resetHeartbeats()
  }

  private broadcastChannelState<Channel extends keyof State>(channel: Channel) {
    const value = this.#localState[channel]
    this.doBroadcast("update", { channel, value })
    this.resetHeartbeats()
  }

  private resetHeartbeats() {
    // Reset heartbeats every time we broadcast a message to avoid sending
    // unnecessary heartbeats when there is plenty of actual update activity
    // happening.
    this.stopHeartbeats()
    this.startHeartbeats()
  }

  private doBroadcast(
    type: PresenceMessageType,
    extra?: Record<string, unknown>
  ) {
    this.send({
      userId: this.userId,
      deviceId: this.deviceId,
      type,
      ...extra,
    })
  }

  private send(message: Record<string, unknown>) {
    if (!this.#running) {
      return
    }
    this.#handle.broadcast({
      [PRESENCE_MESSAGE_MARKER]: message,
    })
  }

  private startHeartbeats() {
    if (this.#heartbeatInterval !== undefined) {
      return
    }
    this.#heartbeatInterval = setInterval(() => {
      this.send({ type: "heartbeat" })
    }, this.#heartbeatMs)
  }

  private stopHeartbeats() {
    if (this.#heartbeatInterval === undefined) {
      return
    }
    clearInterval(this.#heartbeatInterval)
    this.#heartbeatInterval = undefined
  }

  private startPruningPeers() {
    if (this.#pruningInterval !== undefined) {
      return
    }
    // Pruning happens at the heartbeat frequency, not on a peer ttl frequency,
    // to minimize variance between peer expiration, since the heartbeat frequency
    // is expected to be several times higher.
    this.#pruningInterval = setInterval(() => {
      this.#peers.prune()
    }, this.#heartbeatMs)
  }

  private stopPruningPeers() {
    if (this.#pruningInterval === undefined) {
      return
    }
    clearInterval(this.#pruningInterval)
    this.#pruningInterval = undefined
  }
}

class PeerPresenceInfo<State extends PresenceState> {
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
        lastSeen: Date.now(),
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
        lastUpdateAt: now,
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
        Object.entries(this.#peerStates).filter(([, state]) => {
          return state.lastActiveAt >= threshold
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
      const lastSeenAt = this.value[curr]?.lastActiveAt
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
