import {
  NetworkAdapter,
  PeerId,
  cbor,
  isValidRepoMessage,
} from "@automerge/automerge-repo"
import WebSocket from "isomorphic-ws"

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

abstract class WebSocketNetworkAdapter extends NetworkAdapter {
  socket?: WebSocket
}

export class BrowserWebSocketClientAdapter extends WebSocketNetworkAdapter {
  #isReady: boolean = false
  #retryTimer?: TimeoutId
  #log = debug("automerge-repo:websocket:browser")

  remotePeerId?: PeerId // this adapter only connects to one remote client at a time

  constructor(
    public readonly url: string,
    public readonly autoReconnect = true
  ) {
    super()
    this.#log = this.#log.extend(url)
  }

  connect(peerId: PeerId) {
    if (!this.socket || !this.peerId) {
      // first time connecting
      this.#log("connecting")
      this.peerId = peerId
    } else {
      this.#log("reconnecting")
      assert(peerId === this.peerId)
      // Remove the old event listeners before creating a new connection.
      this.socket.removeEventListener("open", this.onOpen)
      this.socket.removeEventListener("close", this.onClose)
      this.socket.removeEventListener("message", this.onMessage)
    }

    // Wire up retries
    if (!this.#retryTimer)
      this.#retryTimer = setInterval(() => this.connect(peerId), 5000)

    this.socket = new WebSocket(this.url)
    this.socket.binaryType = "arraybuffer"

    this.socket.addEventListener("open", this.onOpen)
    this.socket.addEventListener("close", this.onClose)
    this.socket.addEventListener("message", this.onMessage)

    // Mark this adapter as ready if we haven't received an ack in 1 second.
    // We might hear back from the other end at some point but we shouldn't
    // hold up marking things as unavailable for any longer
    setTimeout(() => this.#ready(), 1000)
    this.join()
  }

  onOpen = () => {
    this.#log("open")
    clearInterval(this.#retryTimer)
    this.#retryTimer = undefined
    this.join()
  }

  // When a socket closes, or disconnects, remove it from the array.
  onClose = () => {
    this.#log("close")
    assert(this.peerId)
    if (this.remotePeerId)
      this.emit("peer-disconnected", { peerId: this.remotePeerId })

    if (!this.#retryTimer && this.autoReconnect)
      // try to reconnect
      this.connect(this.peerId)
  }

  onMessage = (event: WebSocket.MessageEvent) => {
    this.receiveMessage(event.data as Uint8Array)
  }

  #ready() {
    if (this.#isReady) return

    this.#isReady = true
    this.emit("ready", { network: this })
  }

  join() {
    assert(this.peerId)
    assert(this.socket)
    if (this.socket.readyState === WebSocket.OPEN) {
      this.send(joinMessage(this.peerId))
    } else {
      // We'll try again in the `onOpen` handler
    }
  }

  disconnect() {
    assert(this.peerId)
    assert(this.socket)
    this.send({ type: "leave", senderId: this.peerId })
  }

  send(message: FromClientMessage) {
    if (
      isValidRepoMessage(message) &&
      "data" in message &&
      message.data.byteLength === 0
    )
      throw new Error("tried to send a zero-length message")
    assert(this.peerId)
    assert(this.socket)
    if (this.socket.readyState !== WebSocket.OPEN)
      throw new Error(`Websocket not ready (${this.socket.readyState})`)

    const encoded = cbor.encode(message)
    // This incantation deals with websocket sending the whole
    // underlying buffer even if we just have a uint8array view on it
    const arrayBuf = encoded.buffer.slice(
      encoded.byteOffset,
      encoded.byteOffset + encoded.byteLength
    )

    this.socket?.send(arrayBuf)
  }

  peerCandidate(remotePeerId: PeerId) {
    assert(this.socket)
    this.#ready()
    this.remotePeerId = remotePeerId
    this.emit("peer-candidate", { peerId: remotePeerId })
  }

  receiveMessage(messageBytes: Uint8Array) {
    const message: FromServerMessage = cbor.decode(new Uint8Array(messageBytes))

    assert(this.socket)
    if (messageBytes.byteLength === 0)
      throw new Error("received a zero-length message")

    if (isPeerMessage(message)) {
      this.#log(`peer: ${message.senderId}`)
      this.peerCandidate(message.senderId)
    } else if (isErrorMessage(message)) {
      this.#log(`error: ${message.message}`)
    } else {
      this.emit("message", message)
    }
  }
}

function joinMessage(senderId: PeerId): JoinMessage {
  return {
    type: "join",
    senderId,
    supportedProtocolVersions: [ProtocolV1],
  }
}

type TimeoutId = ReturnType<typeof setTimeout> //  https://stackoverflow.com/questions/45802988
