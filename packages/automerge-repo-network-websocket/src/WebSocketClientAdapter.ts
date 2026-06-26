import {
  NetworkAdapter,
  PeerId,
  PeerMetadata,
  cbor,
} from "@automerge/automerge-repo/slim"

import debug from "debug"

import {
  FromClientMessage,
  FromServerMessage,
  JoinMessage,
  isErrorMessage,
  isPeerMessage,
} from "./messages.js"
import { ProtocolV1 } from "./protocolVersion.js"
import { assert } from "./assert.js"
import { toArrayBuffer } from "./toArrayBuffer.js"

abstract class WebSocketNetworkAdapter extends NetworkAdapter {
  socket?: WebSocket
}

export class WebSocketClientAdapter extends WebSocketNetworkAdapter {
  #ready = false
  #readyResolver?: () => void
  #readyPromise: Promise<void> = new Promise<void>(resolve => {
    this.#readyResolver = resolve
  })

  isReady() {
    return this.#ready
  }

  whenReady() {
    return this.#readyPromise
  }

  #forceReady() {
    if (!this.#ready) {
      this.#ready = true
      this.#readyResolver?.()
    }
  }

  #retryIntervalId?: TimeoutId
  // The one-shot reconnect timer armed in onClose() and the forceReady fallback
  // timer armed in connect(), held on the instance so disconnect() can cancel
  // them.
  #reconnectTimeoutId?: TimeoutId
  #forceReadyTimeoutId?: TimeoutId
  // Set by disconnect(); guards the reconnect timer so a pending reconnect that
  // fires after disconnect() does not revive the socket.
  #disconnected = false
  #log = debug("automerge-repo:websocket:browser")

  remotePeerId?: PeerId // this adapter only connects to one remote client at a time

  constructor(
    public readonly url: string,
    public readonly retryInterval = 5000
  ) {
    super()
    this.#log = this.#log.extend(url)
  }

  connect(peerId: PeerId, peerMetadata?: PeerMetadata) {
    this.#disconnected = false
    if (!this.socket || !this.peerId) {
      // first time connecting
      this.#log("connecting")
      this.peerId = peerId
      this.peerMetadata = peerMetadata ?? {}
    } else {
      this.#log("reconnecting")
      assert(peerId === this.peerId)
      // Remove the old event listeners before creating a new connection.
      this.socket.removeEventListener("open", this.onOpen)
      this.socket.removeEventListener("close", this.onClose)
      this.socket.removeEventListener("message", this.onMessage)
      this.socket.removeEventListener("error", this.onError)
    }
    // Wire up retries
    if (!this.#retryIntervalId)
      this.#retryIntervalId = setInterval(() => {
        this.connect(peerId, peerMetadata)
      }, this.retryInterval)

    this.socket = new WebSocket(this.url)

    this.socket.binaryType = "arraybuffer"

    this.socket.addEventListener("open", this.onOpen)
    this.socket.addEventListener("close", this.onClose)
    this.socket.addEventListener("message", this.onMessage)
    this.socket.addEventListener("error", this.onError)

    // Mark this adapter as ready if we haven't received an ack in 1 second.
    // We might hear back from the other end at some point but we shouldn't
    // hold up marking things as unavailable for any longer. Clear any pending
    // fallback so reconnects don't accumulate timers.
    clearTimeout(this.#forceReadyTimeoutId)
    this.#forceReadyTimeoutId = setTimeout(() => this.#forceReady(), 1000)
    this.join()
  }

  onOpen = () => {
    this.#log("open")
    clearInterval(this.#retryIntervalId)
    this.#retryIntervalId = undefined
    this.join()
  }

  // When a socket closes, or disconnects, remove it from the array.
  onClose = () => {
    this.#log("close")
    if (this.remotePeerId)
      this.emit("peer-disconnected", { peerId: this.remotePeerId })

    if (this.retryInterval > 0 && !this.#retryIntervalId)
      // try to reconnect
      this.#reconnectTimeoutId = setTimeout(() => {
        // Skip the reconnect if disconnect() ran after it was scheduled.
        if (this.#disconnected) return
        assert(this.peerId)
        return this.connect(this.peerId, this.peerMetadata)
      }, this.retryInterval)
  }

  onMessage = (event: MessageEvent) => {
    this.receiveMessage(event.data as Uint8Array)
  }

  /** Native WebSocket error events are intentionally opaque — on both the
   * browser and Node the error detail is withheld from scripts by design
   * (https://stackoverflow.com/a/31003057/239663) — so we just log and let
   * the retry logic reconnect. */
  onError = () => {
    this.#log("Connection failed, retrying...")
  }

  join() {
    assert(this.peerId)
    assert(this.socket)
    if (this.socket.readyState === WebSocket.OPEN) {
      this.send(joinMessage(this.peerId!, this.peerMetadata!))
    } else {
      // We'll try again in the `onOpen` handler
    }
  }

  disconnect() {
    // disconnect() can be called more than once (e.g. React StrictMode double-
    // invokes the effect cleanup that runs repo.shutdown()); make it idempotent
    // rather than tripping the assert below on the second call.
    if (this.#disconnected) return
    assert(this.peerId)
    assert(this.socket)
    this.#disconnected = true
    const socket = this.socket
    if (socket) {
      socket.removeEventListener("open", this.onOpen)
      socket.removeEventListener("close", this.onClose)
      socket.removeEventListener("message", this.onMessage)
      socket.removeEventListener("error", this.onError)
      socket.close()
    }
    // Cancel every pending timer and clear its id, so a later connect() can
    // re-arm the retry interval (the connect() guard re-arms only when the id
    // is unset).
    clearInterval(this.#retryIntervalId)
    this.#retryIntervalId = undefined
    clearTimeout(this.#reconnectTimeoutId)
    this.#reconnectTimeoutId = undefined
    clearTimeout(this.#forceReadyTimeoutId)
    this.#forceReadyTimeoutId = undefined
    if (this.remotePeerId)
      this.emit("peer-disconnected", { peerId: this.remotePeerId })
    this.socket = undefined
  }

  send(message: FromClientMessage) {
    if ("data" in message && message.data?.byteLength === 0)
      throw new Error("Tried to send a zero-length message")
    assert(this.peerId)
    if (!this.socket) {
      this.#log("Tried to send on a disconnected socket.")
      return
    }
    if (this.socket.readyState !== WebSocket.OPEN) {
      // CONNECTING / CLOSING / CLOSED. Drop silently — sync state and
      // reconnect logic will replay once the socket is OPEN again.
      this.#log(
        `Tried to send on a non-OPEN socket (readyState=${this.socket.readyState}); dropping.`
      )
      return
    }

    const encoded = cbor.encode(message)
    this.socket.send(toArrayBuffer(encoded))
  }

  peerCandidate(remotePeerId: PeerId, peerMetadata: PeerMetadata) {
    assert(this.socket)
    this.#forceReady()
    this.remotePeerId = remotePeerId
    this.emit("peer-candidate", {
      peerId: remotePeerId,
      peerMetadata,
    })
  }

  receiveMessage(messageBytes: Uint8Array) {
    let message: FromServerMessage
    try {
      message = cbor.decode(new Uint8Array(messageBytes))
    } catch (e) {
      this.#log("error decoding message:", e)
      return
    }

    assert(this.socket)
    if (messageBytes.byteLength === 0)
      throw new Error("received a zero-length message")

    if (isPeerMessage(message)) {
      const { peerMetadata } = message
      this.#log(`peer: ${message.senderId}`)
      this.peerCandidate(message.senderId, peerMetadata)
    } else if (isErrorMessage(message)) {
      this.#log(`error: ${message.message}`)
    } else {
      this.emit("message", message)
    }
  }
}

function joinMessage(
  senderId: PeerId,
  peerMetadata: PeerMetadata
): JoinMessage {
  return {
    type: "join",
    senderId,
    peerMetadata,
    supportedProtocolVersions: [ProtocolV1],
  }
}

type TimeoutId = ReturnType<typeof setTimeout> //  https://stackoverflow.com/questions/45802988
