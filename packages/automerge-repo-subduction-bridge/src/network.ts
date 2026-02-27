/**
 * Bridge that allows Subduction to use `automerge-repo` network adapters.
 */

import debug from "debug"
import type {
  NetworkAdapterInterface,
  Message as RepoMessage,
} from "@automerge/automerge-repo"
import {
  Nonce,
  RequestId,
  Message,
  type Connection,
  type Message as SubductionMessage,
  type BatchSyncRequest,
  type BatchSyncResponse,
  type PeerId,
} from "@automerge/automerge-subduction"

/**
 * A connection that wraps an `automerge-repo` `NetworkAdapter` to implement
 * Subduction's `Connection` interface.
 *
 * This allows Subduction to communicate over any automerge-repo network adapter
 * (`BroadcastChannel`, `MessageChannel`, etc.) by encoding Subduction messages
 * within the adapter's message format, and decoding this on the other end.
 *
 * Note that both ends of the connection must be able to understand the transport.
 */
export class NetworkAdapterConnection implements Connection {
  #adapter: NetworkAdapterInterface
  #localPeerId: PeerId
  #remotePeerId: PeerId

  // For pull-based recv()
  #messageQueue: SubductionMessage[] = []
  #waitingReceivers: Array<(msg: SubductionMessage) => void> = []

  // For call() request/response correlation
  #pendingCalls = new Map<
    string,
    {
      resolve: (resp: BatchSyncResponse) => void
      reject: (err: Error) => void
      timeoutId?: ReturnType<typeof setTimeout>
    }
  >()

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

    let subductionMsg: SubductionMessage
    try {
      subductionMsg = Message.fromBytes(msg.data)
    } catch {
      console.error("Failed to decode Subduction message:", msg.data)
      return
    }

    // Check if this is a BatchSyncResponse for a pending call()
    if (subductionMsg.type === "BatchSyncResponse") {
      const resp = subductionMsg.response
      if (resp) {
        const key = this.#requestIdKey(resp.request_id())
        const pending = this.#pendingCalls.get(key)

        if (pending) {
          if (pending.timeoutId) clearTimeout(pending.timeoutId)
          this.#pendingCalls.delete(key)
          pending.resolve(resp)
          return
        }
      }
    }

    // Otherwise queue for recv()
    const receiver = this.#waitingReceivers.shift()
    if (receiver) {
      receiver(subductionMsg)
    } else {
      this.#messageQueue.push(subductionMsg)
    }
  }

  #handlePeerDisconnected = ({ peerId }: { peerId: string }) => {
    if (peerId === this.#remotePeerId.toString()) {
      this.#disconnected = true
      this.#pendingCalls.forEach(pending => {
        if (pending.timeoutId) clearTimeout(pending.timeoutId)
        pending.reject(new Error("Peer disconnected"))
      })
      this.#pendingCalls.clear()
    }
  }

  #requestIdKey(reqId: RequestId): string {
    const nonceBytes: Uint8Array = reqId.nonce.bytes
    const nonceHex = Array.from(nonceBytes)
      .map((b: number) => b.toString(16).padStart(2, "0"))
      .join("")
    return `${reqId.requestor}:${nonceHex}`
  }

  /**
   * Get the peer ID of the remote peer.
   */
  peerId(): PeerId {
    return this.#remotePeerId
  }

  /**
   * Disconnect from the peer.
   *
   * Note: This doesn't close the underlying adapter since it may be shared
   * with other connections. It just stops listening for this peer's messages.
   */
  async disconnect(): Promise<void> {
    this.#disconnected = true
    this.#adapter.off("message", this.#handleMessage)
    this.#adapter.off("peer-disconnected", this.#handlePeerDisconnected)

    this.#pendingCalls.forEach(pending => {
      if (pending.timeoutId) clearTimeout(pending.timeoutId)
      pending.reject(new Error("Disconnected"))
    })
    this.#pendingCalls.clear()
  }

  /**
   * Send a Subduction message to the remote peer.
   */
  async send(message: SubductionMessage): Promise<void> {
    if (this.#disconnected) {
      throw new Error("Connection is disconnected")
    }

    const encoded = message.toBytes()

    this.#adapter.send({
      type: SUBDUCTION_MESSAGE_TYPE,
      senderId: this.#localPeerId.toString() as RepoMessage["senderId"],
      targetId: this.#remotePeerId.toString() as RepoMessage["targetId"],
      data: encoded,
    })
  }

  /**
   * Receive the next Subduction message from the remote peer.
   *
   * This returns a Promise that resolves when a message is available.
   */
  async recv(): Promise<SubductionMessage> {
    if (this.#disconnected) {
      throw new Error("Connection is disconnected")
    }

    const queued = this.#messageQueue.shift()
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
   * Get the next request ID for making calls.
   */
  async nextRequestId(): Promise<RequestId> {
    const nonce = Nonce.random()
    return new RequestId(this.#localPeerId, nonce)
  }

  /**
   * Make a request/response call to the remote peer.
   *
   * @param request - The BatchSyncRequest to send
   * @param timeoutMs - Timeout in milliseconds (null for no timeout)
   * @returns The BatchSyncResponse from the peer
   */
  async call(
    request: BatchSyncRequest,
    timeoutMs: number | null
  ): Promise<BatchSyncResponse> {
    if (this.#disconnected) {
      throw new Error("Connection is disconnected")
    }

    const key = this.#requestIdKey(request.request_id())

    return new Promise((resolve, reject) => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined

      if (timeoutMs !== null) {
        timeoutId = setTimeout(() => {
          this.#pendingCalls.delete(key)
          reject(new Error("Call timed out"))
        }, timeoutMs)
      }

      this.#pendingCalls.set(key, { resolve, reject, timeoutId })

      const message = Message.batchSyncRequest(request)
      this.send(message).catch(err => {
        if (timeoutId) clearTimeout(timeoutId)
        this.#pendingCalls.delete(key)
        reject(err)
      })
    })
  }
}

const SUBDUCTION_MESSAGE_TYPE = "subduction-connection"
const log = debug("automerge-repo:subduction-bridge:network")
