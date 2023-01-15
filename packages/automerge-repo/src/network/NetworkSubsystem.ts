import EventEmitter from "eventemitter3"
import { ChannelId, NetworkAdapter, NetworkEvents, PeerId } from "../types"

import debug from "debug"
const log = debug("NetworkSubsystem")

export class NetworkSubsystem extends EventEmitter<NetworkEvents> {
  networkAdapters: NetworkAdapter[] = []

  myPeerId: PeerId
  peerIdToAdapter: { [peerId: PeerId]: NetworkAdapter } = {}
  channels: ChannelId[]

  constructor(networkAdapters: NetworkAdapter[], peerId?: PeerId) {
    super()
    this.myPeerId =
      peerId || (`user-${Math.round(Math.random() * 100000)}` as PeerId)
    log("local peerID: ", this.myPeerId)

    this.channels = []

    this.networkAdapters = networkAdapters
    networkAdapters.forEach((a) => this.addNetworkAdapter(a))
  }

  addNetworkAdapter(networkAdapter: NetworkAdapter) {
    networkAdapter.connect(this.myPeerId)
    networkAdapter.on("peer-candidate", ({ peerId, channelId }) => {
      if (!this.peerIdToAdapter[peerId]) {
        // TODO: handle losing a server here
        this.peerIdToAdapter[peerId] = networkAdapter
      }

      this.emit("peer", { peerId, channelId })
    })
    networkAdapter.on("peer-disconnected", ({ peerId }) => {
      delete this.peerIdToAdapter[peerId]
      this.emit("peer-disconnected", { peerId })
    })

    networkAdapter.on("message", (msg) => {
      const { senderId, targetId, channelId, broadcast, message } = msg
      // If we receive a broadcast message from a network adapter
      // we need to re-broadcast it to all our other peers.
      // This is the world's worst gossip protocol.
      // TODO: This relies on the network forming a tree!
      //       If there are cycles, this approach will loop messages around forever.
      if (broadcast) {
        Object.entries(this.peerIdToAdapter)
          .filter(([id]) => id !== senderId)
          .forEach(([id, peer]) => {
            peer.sendMessage(id as PeerId, channelId, message, broadcast)
          })
      }

      this.emit("message", msg)
    })

    networkAdapter.on("close", () => {
      Object.entries(this.peerIdToAdapter).forEach(([peerId, other]) => {
        if (other === networkAdapter) {
          delete this.peerIdToAdapter[peerId as PeerId]
        }
      })
    })

    this.channels.forEach((c) => networkAdapter.join(c))
  }

  sendMessage(
    peerId: PeerId,
    channelId: ChannelId,
    message: Uint8Array,
    broadcast: boolean
  ) {
    if (broadcast) {
      Object.entries(this.peerIdToAdapter).forEach(([id, peer]) => {
        peer.sendMessage(id as PeerId, channelId, message, true)
      })
    } else {
      const peer = this.peerIdToAdapter[peerId]
      if (!peer) {
        log(`Tried to send message to disconnected peer: ${peerId}`)
        return
      }
      peer.sendMessage(peerId, channelId, message, false)
    }
  }

  join(channelId: ChannelId) {
    this.channels.push(channelId)
    this.networkAdapters.forEach((a) => a.join(channelId))
  }

  leave(channelId: ChannelId) {
    this.channels = this.channels.filter((c) => c !== channelId)
    this.networkAdapters.forEach((a) => a.leave(channelId))
  }
}
