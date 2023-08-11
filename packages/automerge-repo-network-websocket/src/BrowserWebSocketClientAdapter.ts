import { Message, NetworkAdapter, PeerId } from "@automerge/automerge-repo"
import * as CBOR from "cbor-x"
import WebSocket from "isomorphic-ws"

import debug from "debug"

import { ProtocolV1 } from "./protocolVersion.js"
import {
  FromClientMessage,
  FromServerMessage,
  JoinMessage,
} from "./messages.js"

const log = debug("WebsocketClient")

abstract class WebSocketNetworkAdapter extends NetworkAdapter {
  socket?: WebSocket
}

export class BrowserWebSocketClientAdapter extends WebSocketNetworkAdapter {
  timerId?: NodeJS.Timer
  url: string

  constructor(url: string) {
    super()
    this.url = url
  }

  connect(peerId: PeerId) {
    if (!this.timerId) {
      this.timerId = setInterval(() => this.connect(peerId), 5000)
    }

    this.peerId = peerId
    this.socket = new WebSocket(this.url)
    this.socket.binaryType = "arraybuffer"

    this.socket.addEventListener("open", () => {
      log(`@ ${this.url}: open`)
      clearInterval(this.timerId)
      this.timerId = undefined
      this.join()
    })

    // When a socket closes, or disconnects, remove it from the array.
    this.socket.addEventListener("close", () => {
      log(`${this.url}: close`)
      if (!this.timerId) {
        this.connect(peerId)
      }
      // log("Disconnected from server")
    })

    this.socket.addEventListener("message", (event: WebSocket.MessageEvent) =>
      this.receiveMessage(event.data as Uint8Array)
    )
  }

  private transmit(message: FromClientMessage) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Websocket Socket not ready!")
    }

    const encoded = CBOR.encode(message)
    // This incantation deals with websocket sending the whole
    // underlying buffer even if we just have a uint8array view on it
    const arrayBuf = encoded.buffer.slice(
      encoded.byteOffset,
      encoded.byteOffset + encoded.byteLength
    )

    this.socket?.send(arrayBuf)
  }

  join() {
    if (!this.socket) {
      throw new Error("WTF, get a socket")
    }
    if (this.socket.readyState === WebSocket.OPEN) {
      this.transmit(joinMessage(this.peerId!))
    } else {
      this.socket.addEventListener(
        "open",
        () => {
          if (!this.socket) {
            throw new Error("WTF, get a socket")
          }
          this.transmit(joinMessage(this.peerId!))
        },
        { once: true }
      )
    }
  }

  leave() {
    if (!this.socket) {
      throw new Error("WTF, get a socket")
    }
    this.transmit({ type: "leave", senderId: this.peerId! })
  }

  send(message: Message) {
    if ("data" in message && message.data.byteLength === 0) {
      throw new Error("tried to send a zero-length message")
    }

    if (!this.peerId) {
      throw new Error("Why don't we have a PeerID?")
    }

    this.transmit(message)
  }

  announceConnection(peerId: PeerId) {
    // return a peer object
    const myPeerId = this.peerId
    if (!myPeerId) {
      throw new Error("we should have a peer ID by now")
    }

    this.emit("peer-candidate", { peerId })
  }

  receiveMessage(message: Uint8Array) {
    const decoded: FromServerMessage = CBOR.decode(new Uint8Array(message))

    const { type, senderId } = decoded

    const socket = this.socket
    if (!socket) {
      throw new Error("Missing socket at receiveMessage")
    }

    if (message.byteLength === 0) {
      throw new Error("received a zero-length message")
    }

    switch (type) {
      case "peer":
        log(`peer: ${senderId}`)
        this.announceConnection(senderId)
        break
      case "error":
        log(`error: ${decoded.message}`)
        break
      default:
        this.emit("message", decoded)
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
