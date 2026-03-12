/**
 * Bridge that allows Subduction to use `automerge-repo` network adapters.
 *
 * Implements the full {@link HandshakeConnection} interface (which extends
 * {@link Connection}) so that a single {@link NetworkAdapterConnection} can be
 * used for both the cryptographic handshake phase (`sendBytes`/`recvBytes`)
 * and the subsequent sync phase (`send`/`recv`).
 *
 * All frames travel through the same `NetworkAdapter` `data` field with a
 * one-byte tag prefix to distinguish handshake bytes from post-handshake
 * structured messages:
 *
 * - `0x00` — handshake frame  (raw `Uint8Array`, used during `sendBytes`/`recvBytes`)
 * - `0x01` — message frame    (a serialised Subduction `Message`, used during `send`/`recv`)
 *
 * Both peers must use this adapter (or an equivalent that speaks the same
 * tagging convention) for the connection to succeed.
 */

import debug from "debug"
import type {
  NetworkAdapterInterface,
  PeerId,
  Message as RepoMessage,
} from "../index.js"
import {
  Nonce,
  RequestId,
  type Transport,
} from "@automerge/automerge-subduction/slim"

/**
 * A connection that wraps an `automerge-repo` `NetworkAdapter` to implement
 * Subduction's `HandshakeConnection` interface.
 *
 * This allows Subduction to communicate over any automerge-repo network adapter
 * (`BroadcastChannel`, `MessageChannel`, etc.) by encoding Subduction frames
 * within the adapter's message format, and decoding them on the other end.
 *
 * Note that both ends of the connection must be able to understand the
 * tag-prefixed transport framing.
 */
export class NetworkAdapterTransport implements Transport {
  #adapter: NetworkAdapterInterface
  #localPeerId: PeerId
  #remotePeerId: PeerId

  // --- Post-handshake message queue (Phase 2) ---
  #messageQueue: Uint8Array[] = []
  #messageWaiters: Array<(msg: Uint8Array) => void> = []
  #log: debug.Debugger
  #disconnectCallback: (() => void) | null = null

  #disconnected = false

  /**
   * Create a new NetworkAdapterConnection.
   *
   * @param adapter      - The automerge-repo network adapter to wrap.
   * @param remotePeerId - The remote peer's automerge-repo PeerId.
   */
  constructor(
    adapter: NetworkAdapterInterface,
    localPeerId: PeerId,
    remotePeerId: PeerId
  ) {
    this.#adapter = adapter
    this.#localPeerId = localPeerId
    this.#remotePeerId = remotePeerId
    this.#log = debug(
      `automerge-repo:subduction:network:${localPeerId}-${remotePeerId}`
    )

    adapter.on("message", this.#handleMessage)
    adapter.on("peer-disconnected", this.#handlePeerDisconnected)
  }

  onDisconnect(callback: () => void): void {
    this.#disconnectCallback = callback
  }

  // -----------------------------------------------------------------------
  // Internal event handlers
  // -----------------------------------------------------------------------

  #handleMessage = (msg: RepoMessage) => {
    this.#log("handling message", msg)
    if (msg.targetId != this.#localPeerId) {
      this.#log("message targetId mismatch", msg.targetId, this.#remotePeerId)
      return
    }

    // Only process our custom message type.
    if (msg.type !== SUBDUCTION_MESSAGE_TYPE) {
      this.#log("message type mismatch", msg.type, SUBDUCTION_MESSAGE_TYPE)
      return
    }

    const payload = msg.data
    if (!payload || payload.length === 0) {
      this.#log("ignoring message with no data")
      return
    }

    // Otherwise enqueue for recv().
    const waiter = this.#messageWaiters.shift()
    if (waiter) {
      waiter(payload)
    } else {
      this.#messageQueue.push(payload)
    }
  }

  #handlePeerDisconnected = ({ peerId }: { peerId: string }) => {
    if (peerId === this.#remotePeerId.toString()) {
      this.#teardown()
    }
  }

  /** Send a tagged frame over the adapter. */
  #sendFrame(data: Uint8Array): void {
    this.#adapter.send({
      type: SUBDUCTION_MESSAGE_TYPE,
      senderId: this.#localPeerId.toString() as RepoMessage["senderId"],
      targetId: this.#remotePeerId.toString() as RepoMessage["targetId"],
      data,
    })
  }

  /** Clean up all waiters and pending calls with the given error. */
  #teardown({
    fireDisconnectCallback,
  }: { fireDisconnectCallback?: boolean } = {}): void {
    this.#adapter.off("message", this.#handleMessage)
    this.#adapter.off("peer-disconnected", this.#handlePeerDisconnected)
    this.#disconnected = true
    if (fireDisconnectCallback && this.#disconnectCallback) {
      this.#disconnectCallback()
    }
  }

  /**
   * Send raw bytes during the handshake phase.
   *
   * The bytes are tagged with `TAG_HANDSHAKE` (`0x00`) so that the remote
   * peer routes them to its own `recvBytes` queue.
   */
  async sendBytes(bytes: Uint8Array): Promise<void> {
    if (this.#disconnected) {
      return Promise.reject(new Error("Connection is disconnected"))
    }
    this.#sendFrame(bytes)
  }

  /**
   * Receive raw bytes during the handshake phase.
   *
   * Returns the next `TAG_HANDSHAKE`-tagged payload, waiting if none is
   * available yet.
   */
  recvBytes(): Promise<Uint8Array> {
    if (this.#disconnected) {
      return Promise.reject(new Error("Connection is disconnected"))
    }

    return new Promise<Uint8Array>((resolve, reject) => {
      if (this.#disconnected) {
        reject(new Error("Connection is disconnected"))
        return
      }
      this.#messageWaiters.push(resolve)
    })
  }

  /**
   * Disconnect from the peer.
   *
   * This does *not* close the underlying adapter (which may be shared with
   * other connections). It only unsubscribes this connection's listeners.
   */
  async disconnect(): Promise<void> {
    this.#teardown({ fireDisconnectCallback: false })
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The `type` value used on automerge-repo messages that carry Subduction
 * frames. Both handshake and post-handshake frames share this type; the
 * tag byte inside `data` distinguishes them.
 */
export const SUBDUCTION_MESSAGE_TYPE = "subduction-connection"

const log = debug("automerge-repo:subduction:network")
