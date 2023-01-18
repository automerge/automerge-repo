import EventEmitter from "eventemitter3"
import { ChannelId, PeerId } from "../types"
import { NetworkAdapter, NetworkEvents } from "./types"

import debug from "debug"

export class NetworkSubsystem extends EventEmitter<NetworkEvents> {
  #log: debug.Debugger
  #adapters: Record<PeerId, NetworkAdapter> = {}
  #channels: ChannelId[]

  peerId: PeerId

  constructor(networkAdapters: NetworkAdapter[], peerId?: PeerId) {
    super()
    this.peerId =
      peerId || (`user-${Math.round(Math.random() * 100000)}` as PeerId)

    this.#log = debug(`ar:network:${this.peerId}`)

    this.#channels = []

    networkAdapters.forEach(a => this.addNetworkAdapter(a))
  }

  addNetworkAdapter(networkAdapter: NetworkAdapter) {
    networkAdapter.connect(this.peerId)

    networkAdapter.on("peer-candidate", ({ peerId, channelId }) => {
      this.#log(`peer candidate: ${peerId} `)
      if (!this.#adapters[peerId]) {
        // TODO: handle losing a server here
        this.#adapters[peerId] = networkAdapter
      }

      this.emit("peer", { peerId, channelId })
    })

    networkAdapter.on("peer-disconnected", ({ peerId }) => {
      this.#log(`peer disconnected: ${peerId} `)
      delete this.#adapters[peerId]
      this.emit("peer-disconnected", { peerId })
    })

    networkAdapter.on("message", payload => {
      const { senderId, channelId, broadcast, message } = payload
      this.#log(`message from ${senderId}`)

      // If we receive a broadcast message from a network adapter
      // we need to re-broadcast it to all our other peers.
      // This is the world's worst gossip protocol.
      // TODO: This relies on the network forming a tree!
      //       If there are cycles, this approach will loop messages around forever.
      if (broadcast) {
        Object.entries(this.#adapters)
          .filter(([id]) => id !== senderId)
          .forEach(([id, peer]) => {
            peer.sendMessage(id as PeerId, channelId, message, broadcast)
          })
      }

      this.emit("message", payload)
    })

    networkAdapter.on("close", () => {
      this.#log("adapter closed")
      Object.entries(this.#adapters).forEach(([peerId, other]) => {
        if (other === networkAdapter) {
          delete this.#adapters[peerId as PeerId]
        }
      })
    })

    this.#channels.forEach(c => networkAdapter.join(c))
  }

  sendMessage(
    peerId: PeerId,
    channelId: ChannelId,
    message: Uint8Array,
    broadcast: boolean
  ) {
    if (broadcast) {
      Object.entries(this.#adapters).forEach(([id, peer]) => {
        this.#log(`sending broadcast to ${id}`)
        peer.sendMessage(id as PeerId, channelId, message, true)
      })
    } else {
      const peer = this.#adapters[peerId]
      if (!peer) {
        this.#log(`Tried to send message but peer not found: ${peerId}`)
      }
      this.#log(`Sending message to ${peerId}`)
      peer.sendMessage(peerId, channelId, message, false)
    }
  }

  join(channelId: ChannelId) {
    this.#log(`Joining channel ${channelId}`)
    this.#channels.push(channelId)
    Object.values(this.#adapters).forEach(a => a.join(channelId))
  }

  leave(channelId: ChannelId) {
    this.#log(`Leaving channel ${channelId}`)
    this.#channels = this.#channels.filter(c => c !== channelId)
    Object.values(this.#adapters).forEach(a => a.leave(channelId))
  }
}
