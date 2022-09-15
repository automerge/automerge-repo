import EventEmitter from "eventemitter3"
import * as CBOR from "cbor-x"
import { receiveMessageClient, WebSocketNetworkAdapter } from "./WSShared.js"
import { NetworkAdapterEvents } from "../Network"
import WebSocket from "isomorphic-ws"

export class BrowserWebSocketClientAdapter
  extends EventEmitter<NetworkAdapterEvents>
  implements WebSocketNetworkAdapter
{
  client?: WebSocket
  timerId?: NodeJS.Timer
  peerId?: string
  url: string
  openSockets: WebSocket[] = []

  constructor(url: string) {
    super()
    this.url = url
  }

  connect(peerId: string) {
    this.peerId = peerId
    this.client = new WebSocket(this.url)
    this.client.binaryType = "arraybuffer"
    this.timerId = setInterval(() => this.connect(peerId), 5000)

    this.client.addEventListener("open", () => {
      console.log("Connected to server.")
      clearInterval(this.timerId)
    })

    // When a socket closes, or disconnects, remove it from the array.
    this.client.addEventListener("close", () => {
      console.log("Disconnected from server")
    })

    this.client.addEventListener("message", (event) =>
      receiveMessageClient(event.data as Uint8Array, this)
    )
  }

  join(channelId: string) {
    if (!this.client) {
      throw new Error("WTF, get a client")
    }
    if (this.client.readyState === WebSocket.OPEN) {
      this.client.send(
        CBOR.encode({ type: "join", channelId, senderId: this.peerId })
      )
    } else {
      this.client.addEventListener(
        "open",
        () => {
          if (!this.client) {
            throw new Error("WTF, get a client")
          }
          this.client.send(
            CBOR.encode({ type: "join", channelId, senderId: this.peerId })
          )
        },
        { once: true }
      )
    }
  }

  leave(channelId: string) {
    if (!this.client) {
      throw new Error("WTF, get a client")
    }
    this.client.send(
      CBOR.encode({ type: "leave", channelId, senderId: this.peerId })
    )
  }
}
