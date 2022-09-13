import { Client } from "@localfirst/relay-client"
import EventEmitter from "eventemitter3"
import { NetworkAdapter, NetworkAdapterEvents } from "../Network.js"
import WebSocket from "isomorphic-ws"

class LocalFirstRelayNetworkAdapter
  extends EventEmitter<NetworkAdapterEvents>
  implements NetworkAdapter
{
  url: string
  client?: Client

  constructor(url: string) {
    super()
    this.url = url
  }

  announceConnection(channelId: string, peerId: string, socket: WebSocket) {
    // return a peer object
    const connection = {
      close: () => socket.close(),
      isOpen: () => socket.readyState === WebSocket.OPEN,
      send: (uint8message: Uint8Array) => {
        const message = uint8message.buffer.slice(
          uint8message.byteOffset,
          uint8message.byteOffset + uint8message.byteLength
        )
        socket.send(message)
      },
    }
    this.emit("peer-candidate", { peerId, channelId, connection })
  }

  connect(peerId: string) {
    this.client = new Client({
      userName: peerId,
      url: this.url,
    })

    this.client.on("peer.connect", (ev) => {
      const documentId: string = ev.detail.documentId
      const userName: string = ev.detail.userName
      const socket: WebSocket = ev.detail.socket

      socket.binaryType = "arraybuffer"
      this.announceConnection(documentId, userName, socket)

      // listen for messages
      socket.onmessage = (e) => {
        const message = new Uint8Array(e.data as ArrayBuffer)
        this.emit("message", {
          senderId: userName,
          channelId: documentId,
          message,
        })
      }
    })
  }

  join(docId: string) {
    this.client!.join(docId)
  }

  leave(docId: string) {
    this.client!.leave(docId)
  }
}

export default LocalFirstRelayNetworkAdapter
