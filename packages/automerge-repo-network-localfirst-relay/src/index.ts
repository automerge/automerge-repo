import { Client } from "@localfirst/relay-client"
import EventEmitter from "eventemitter3"
import {
  ChannelId,
  NetworkAdapter,
  NetworkAdapterEvents,
  PeerId,
} from "automerge-repo"
import WebSocket from "isomorphic-ws"

export class LocalFirstRelayNetworkAdapter
  extends EventEmitter<NetworkAdapterEvents>
  implements NetworkAdapter
{
  url: string
  client?: Client

  constructor(url: string) {
    super()
    this.url = url
  }

  announceConnection(channelId: ChannelId, peerId: PeerId, socket: WebSocket) {
    // return a peer object
    const connection = {
      close: () => socket.close(),
      isOpen: () => socket.readyState === WebSocket.OPEN,
      send: (channelId, uint8message: Uint8Array) => {
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
      const channelId: ChannelId = ev.detail.documentId
      const userName: PeerId = ev.detail.userName
      const socket: WebSocket = ev.detail.socket

      socket.binaryType = "arraybuffer"
      this.announceConnection(channelId, userName, socket)

      // listen for messages
      socket.onmessage = (e) => {
        const message = new Uint8Array(e.data as ArrayBuffer)
        this.emit("message", {
          peerId: userName,
          channelId,
          message,
        })
      }
    })
  }

  join(channelId: ChannelId) {
    this.client!.join(channelId)
  }

  leave(channelId: ChannelId) {
    this.client!.leave(channelId)
  }
}
