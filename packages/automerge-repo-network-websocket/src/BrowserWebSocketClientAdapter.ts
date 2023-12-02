import {
  NetworkAdapter,
  type PeerId,
  type PeerMetadata,
  cbor,
} from "@automerge/automerge-repo"
import WebSocket from "isomorphic-ws"

import debug from "debug"

import {
  FromClientMessage,
  FromServerMessage,
  JoinMessage,
  PeerMessage,
} from "./messages.js"
import { ProtocolV1 } from "./protocolVersion.js"

const log = debug("WebsocketClient")

abstract class WebSocketNetworkAdapter extends NetworkAdapter {
  socket?: WebSocket
}

export class BrowserWebSocketClientAdapter extends WebSocketNetworkAdapter {
  timerId?: TimeoutId
  remotePeerId?: PeerId // this adapter only connects to one remote client at a time
  #startupComplete: boolean = false

  url: string

  constructor(url: string) {
    super()
    this.url = url
  }

  connect(peerId: PeerId, peerMetadata: PeerMetadata) {
    // If we're reconnecting  make sure we remove the old event listeners
    // before creating a new connection.
    if (this.socket) {
      this.socket.removeEventListener("open", this.onOpen)
      this.socket.removeEventListener("close", this.onClose)
      this.socket.removeEventListener("message", this.onMessage)
    }

    if (!this.timerId) {
      this.timerId = setInterval(() => this.connect(peerId, peerMetadata), 5000)
    }

    this.peerId = peerId
    this.peerMetadata = peerMetadata
    this.socket = new WebSocket(this.url)
    this.socket.binaryType = "arraybuffer"

    this.socket.addEventListener("open", this.onOpen)
    this.socket.addEventListener("close", this.onClose)
    this.socket.addEventListener("message", this.onMessage)

    // mark this adapter as ready if we haven't received an ack in 1 second.
    // We might hear back from the other end at some point but we shouldn't
    // hold up marking things as unavailable for any longer
    setTimeout(() => {
      if (!this.#startupComplete) {
        this.#startupComplete = true
        this.emit("ready", { network: this })
      }
    }, 1000)

    this.join()
  }

  onOpen = () => {
    log(`@ ${this.url}: open`)
    clearInterval(this.timerId)
    this.timerId = undefined
    this.send(joinMessage(this.peerId!, this.peerMetadata!))
  }

  // When a socket closes, or disconnects, remove it from the array.
  onClose = () => {
    log(`${this.url}: close`)

    if (this.remotePeerId) {
      this.emit("peer-disconnected", { peerId: this.remotePeerId })
    }

    if (!this.timerId) {
      if (this.peerId) {
        this.connect(this.peerId, this.peerMetadata!)
      }
    }
  }

  onMessage = (event: WebSocket.MessageEvent) => {
    this.receiveMessage(event.data as Uint8Array)
  }

  join() {
    if (!this.socket) {
      throw new Error("WTF, get a socket")
    }
    if (this.socket.readyState === WebSocket.OPEN) {
      this.send(joinMessage(this.peerId!, this.peerMetadata!))
    } else {
      // The onOpen handler automatically sends a join message
    }
  }

  disconnect() {
    if (!this.socket) {
      throw new Error("WTF, get a socket")
    }
    this.send({ type: "leave", senderId: this.peerId! })
  }

  send(message: FromClientMessage) {
    if ("data" in message && message.data.byteLength === 0) {
      throw new Error("tried to send a zero-length message")
    }

    if (!this.peerId) {
      throw new Error("Why don't we have a PeerID?")
    }

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Websocket Socket not ready!")
    }

    const encoded = cbor.encode(message)
    // This incantation deals with websocket sending the whole
    // underlying buffer even if we just have a uint8array view on it
    const arrayBuf = encoded.buffer.slice(
      encoded.byteOffset,
      encoded.byteOffset + encoded.byteLength
    )

    this.socket?.send(arrayBuf)
  }

  announceConnection(peerId: PeerId, peerMetadata: PeerMetadata) {
    // return a peer object
    const myPeerId = this.peerId
    if (!myPeerId) {
      throw new Error("we should have a peer ID by now")
    }
    if (!this.#startupComplete) {
      this.#startupComplete = true
      this.emit("ready", { network: this })
    }
    this.remotePeerId = peerId
    this.emit("peer-candidate", { peerId, peerMetadata })
  }

  receiveMessage(message: Uint8Array) {
    const decoded: FromServerMessage = cbor.decode(new Uint8Array(message))

    const { type, senderId } = decoded

    const socket = this.socket
    if (!socket) {
      throw new Error("Missing socket at receiveMessage")
    }

    if (message.byteLength === 0) {
      throw new Error("received a zero-length message")
    }

    switch (type) {
      case "peer": {
        const { peerMetadata } = decoded
        log(`peer: ${senderId}`)
        this.announceConnection(senderId, peerMetadata)
        break
      }
      case "error":
        log(`error: ${decoded.message}`)
        break
      default:
        this.emit("message", decoded)
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
