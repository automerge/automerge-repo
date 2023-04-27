import {
  ChannelId,
  InboundMessagePayload,
  NetworkAdapter,
  PeerId,
} from "automerge-repo"
import * as CBOR from "cbor-x"
import WebSocket from "isomorphic-ws"

import debug from "debug"
const log = debug("WebsocketClient")

abstract class WebSocketNetworkAdapter extends NetworkAdapter {
  socket?: WebSocket
}

export class BrowserWebSocketClientAdapter extends WebSocketNetworkAdapter {
  timerId?: NodeJS.Timer
  url: string
  channels: ChannelId[] = []

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
      this.channels.forEach(c => this.join(c))
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

  join(channelId: ChannelId) {
    // TODO: the network subsystem should manage this
    if (!this.channels.includes(channelId)) {
      this.channels.push(channelId)
    }

    if (!this.socket) {
      throw new Error("WTF, get a socket")
    }
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(
        CBOR.encode({ type: "join", channelId, senderId: this.peerId })
      )
    } else {
      this.socket.addEventListener(
        "open",
        () => {
          if (!this.socket) {
            throw new Error("WTF, get a socket")
          }
          this.socket.send(
            CBOR.encode({ type: "join", channelId, senderId: this.peerId })
          )
        },
        { once: true }
      )
    }
  }

  leave(channelId: ChannelId) {
    this.channels = this.channels.filter(c => c !== channelId)
    if (!this.socket) {
      throw new Error("WTF, get a socket")
    }
    this.socket.send(
      CBOR.encode({ type: "leave", channelId, senderId: this.peerId })
    )
  }

  sendMessage(
    targetId: PeerId,
    channelId: ChannelId,
    message: Uint8Array,
    broadcast: boolean
  ) {
    if (message.byteLength === 0) {
      throw new Error("tried to send a zero-length message")
    }
    if (!this.peerId) {
      throw new Error("Why don't we have a PeerID?")
    }

    const decoded: InboundMessagePayload = {
      senderId: this.peerId,
      targetId,
      channelId,
      type: "message",
      message,
      broadcast,
    }

    const encoded = CBOR.encode(decoded)

    // This incantation deals with websocket sending the whole
    // underlying buffer even if we just have a uint8array view on it
    const arrayBuf = encoded.buffer.slice(
      encoded.byteOffset,
      encoded.byteOffset + encoded.byteLength
    )
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Websocket Socket not ready!")
    }
    this.socket.send(arrayBuf)
  }

  announceConnection(channelId: ChannelId, peerId: PeerId) {
    // return a peer object
    const myPeerId = this.peerId
    if (!myPeerId) {
      throw new Error("we should have a peer ID by now")
    }

    this.emit("peer-candidate", { peerId, channelId })
  }

  receiveMessage(message: Uint8Array) {
    const decoded: InboundMessagePayload = CBOR.decode(new Uint8Array(message))

    const {
      type,
      senderId,
      targetId,
      channelId,
      message: messageData,
      broadcast,
    } = decoded

    const socket = this.socket
    if (!socket) {
      throw new Error("Missing socket at receiveMessage")
    }

    if (message.byteLength === 0) {
      throw new Error("received a zero-length message")
    }

    switch (type) {
      case "peer":
        log(`peer: ${senderId}, ${channelId}`)
        this.announceConnection(channelId, senderId)
        break
      default:
        this.emit("message", {
          channelId,
          senderId,
          targetId,
          message: new Uint8Array(messageData),
          broadcast,
        })
    }
  }
}
