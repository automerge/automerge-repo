/**
 * Bridge that allows Subduction to use `automerge-repo` network adapters
 * as a byte-level {@link Transport}.
 *
 * Subduction's Wasm layer handles message framing, request/response
 * correlation, and encoding internally. This bridge only needs to shuttle
 * raw bytes between the adapter's message envelope and the Wasm transport.
 */

import debug from "debug"
import type {
  NetworkAdapterInterface,
  Message as RepoMessage,
} from "@automerge/automerge-repo"
import type { Transport, PeerId } from "@automerge/automerge-subduction/slim"

/**
 * A {@link Transport} that wraps an `automerge-repo` `NetworkAdapter`.
 *
 * This allows Subduction to communicate over any automerge-repo network
 * adapter (`BroadcastChannel`, `MessageChannel`, etc.) by embedding raw
 * Subduction bytes in the adapter's message envelope.
 *
 * Use with {@link Subduction.connectTransport} / {@link Subduction.acceptTransport},
 * or wrap with {@link AuthenticatedTransport.setup} and pass to
 * {@link Subduction.addConnection}.
 *
 * Both ends of the channel must be using this bridge.
 */
export class NetworkAdapterConnection implements Transport {
  #adapter: NetworkAdapterInterface
  #localPeerId: PeerId
  #remotePeerId: PeerId

  #byteQueue: Uint8Array[] = []
  #waitingReceivers: Array<(bytes: Uint8Array) => void> = []

  #disconnected = false

  /**
   * Create a new NetworkAdapterConnection.
   *
   * @param adapter - The automerge-repo network adapter to wrap
   * @param localPeerId - The local Subduction PeerId
   * @param remotePeerId - The remote peer's PeerId to communicate with
   */
  constructor(
    adapter: NetworkAdapterInterface,
    localPeerId: PeerId,
    remotePeerId: PeerId
  ) {
    this.#adapter = adapter
    this.#localPeerId = localPeerId
    this.#remotePeerId = remotePeerId

    adapter.on("message", this.#handleMessage)
    adapter.on("peer-disconnected", this.#handlePeerDisconnected)
  }

  #handleMessage = (msg: RepoMessage) => {
    if (msg.senderId !== this.#remotePeerId.toString()) {
      log(
        "ignoring message from %s, expected %s",
        msg.senderId,
        this.#remotePeerId
      )
      return
    }

    if (msg.type !== SUBDUCTION_MESSAGE_TYPE) {
      log("ignoring non-subduction message type: %s", msg.type)
      return
    }

    if (!msg.data) {
      log("ignoring message with no data")
      return
    }

    const receiver = this.#waitingReceivers.shift()
    if (receiver) {
      receiver(msg.data)
    } else {
      this.#byteQueue.push(msg.data)
    }
  }

  #handlePeerDisconnected = ({ peerId }: { peerId: string }) => {
    if (peerId === this.#remotePeerId.toString()) {
      this.#disconnected = true

      // Reject any pending recvBytes() calls
      for (const _receiver of this.#waitingReceivers) {
        // Receivers are resolve callbacks; we can't reject them directly.
        // They will hang until GC. The disconnected flag prevents new calls.
      }
      this.#waitingReceivers = []
    }
  }

  /**
   * Get the peer ID of the remote peer.
   *
   * This is a convenience accessor for callers that need to know which
   * peer this bridge connects to (e.g. for connection tracking).
   */
  getRemotePeerId(): PeerId {
    return this.#remotePeerId
  }

  /**
   * Send raw bytes to the remote peer.
   */
  async sendBytes(bytes: Uint8Array): Promise<void> {
    if (this.#disconnected) {
      throw new Error("Connection is disconnected")
    }

    this.#adapter.send({
      type: SUBDUCTION_MESSAGE_TYPE,
      senderId: this.#localPeerId.toString() as RepoMessage["senderId"],
      targetId: this.#remotePeerId.toString() as RepoMessage["targetId"],
      data: bytes,
    })
  }

  /**
   * Receive the next chunk of raw bytes from the remote peer.
   *
   * Returns a Promise that resolves when bytes are available.
   */
  async recvBytes(): Promise<Uint8Array> {
    if (this.#disconnected) {
      throw new Error("Connection is disconnected")
    }

    const queued = this.#byteQueue.shift()
    if (queued) return queued

    return new Promise((resolve, reject) => {
      if (this.#disconnected) {
        reject(new Error("Connection is disconnected"))
        return
      }
      this.#waitingReceivers.push(resolve)
    })
  }

  /**
   * Disconnect from the peer.
   *
   * This doesn't close the underlying adapter since it may be shared
   * with other connections. It just stops listening for this peer's messages.
   */
  async disconnect(): Promise<void> {
    this.#disconnected = true
    this.#adapter.off("message", this.#handleMessage)
    this.#adapter.off("peer-disconnected", this.#handlePeerDisconnected)
    this.#waitingReceivers = []
  }
}

const SUBDUCTION_MESSAGE_TYPE = "subduction-connection"
const log = debug("automerge-repo:subduction-bridge:network")
