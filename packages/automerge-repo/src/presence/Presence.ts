import { EventEmitter } from "eventemitter3"

import { DocHandle, DocHandleEphemeralMessagePayload } from "../DocHandle.js"
import {
  PresenceConfig,
  PresenceEvents,
  PresenceMessage,
  PresenceMessageType,
  PresenceState,
} from "./types.js"
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_PEER_TTL_MS,
  PRESENCE_MESSAGE_MARKER,
} from "./constants.js"
import { PeerPresenceInfo } from "./PeerPresenceInfo.js"

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
  constructor({ handle }: { handle: DocHandle<DocType> }) {
    super()
    this.#handle = handle
    this.#peers = new PeerPresenceInfo<State>(DEFAULT_PEER_TTL_MS)
    this.#localState = {} as State
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
            value: { [message.channel]: message.value } as Partial<State>,
          })
          this.emit("update", {
            type: "update",
            peerId,
            channel: message.channel,
            value: message.value,
          })
          break
        case "snapshot":
          this.#peers.update({
            peerId,
            value: message.state as State,
          })
          this.emit("snapshot", {
            type: "snapshot",
            peerId,
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
      const pruned = this.#peers.prune()
      if (pruned.length > 0) {
        this.emit("pruning", { pruned })
      }
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
