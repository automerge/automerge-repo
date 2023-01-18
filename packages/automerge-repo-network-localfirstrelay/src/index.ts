import { Client } from "@localfirst/relay-client"
import { ChannelId, NetworkAdapter, PeerId } from "automerge-repo"
import WebSocket from "isomorphic-ws"

export class LocalFirstRelayNetworkAdapter extends NetworkAdapter {
  url: string
  client?: Client
  sockets: { [peerId: PeerId]: WebSocket } = {}

  constructor(url: string) {
    super()
    this.url = url
  }

  announceConnection(channelId: ChannelId, peerId: PeerId) {
    // return a peer object
    this.emit("peer-candidate", { peerId, channelId })
  }

  sendMessage(
    peerId: PeerId,
    channelId: ChannelId,
    uint8message: Uint8Array,
    broadcast: boolean
  ) {
    // TODO: we're not preserving the channelID or the broadcast flag
    //       not really sure what to do with localfirst relay on this one
    const message = uint8message.buffer.slice(
      uint8message.byteOffset,
      uint8message.byteOffset + uint8message.byteLength
    )
    this.sockets[peerId].send(message)
  }

  connect(peerId: PeerId) {
    this.client = new Client({
      userName: peerId,
      url: this.url,
    })

    this.client.on("peer.connect", ev => {
      const channelId: ChannelId = ev.detail.documentId
      const userName: PeerId = ev.detail.userName
      const socket: WebSocket = ev.detail.socket

      socket.binaryType = "arraybuffer"
      this.announceConnection(channelId, userName)

      // listen for messages
      socket.onmessage = e => {
        const message = new Uint8Array(e.data as ArrayBuffer)
        this.emit("message", {
          senderId: userName,
          targetId: peerId, // TODO: this is bad too
          channelId,
          message,
          broadcast: false, // we don't s
        })
      }
      this.sockets[userName] = socket
    })
  }

  join(channelId: ChannelId) {
    this.client!.join(channelId)
  }

  leave(channelId: ChannelId) {
    this.client!.leave(channelId)
  }
}
