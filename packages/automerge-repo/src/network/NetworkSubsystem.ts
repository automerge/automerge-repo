import debug from "debug"
import EventEmitter from "eventemitter3"

import { ChannelId, PeerId } from "../types.js"
import {
  InboundMessagePayload,
  NetworkAdapter,
  PeerDisconnectedPayload,
} from "./NetworkAdapter.js"

export class NetworkSubsystem extends EventEmitter<NetworkSubsystemEvents> {
  #log: debug.Debugger
  #adaptersByPeer: Record<PeerId, NetworkAdapter> = {}
  #channels: ChannelId[]

  constructor(
    private adapters: NetworkAdapter[],
    public peerId = randomPeerId()
  ) {
    super()
    this.#log = debug(`automerge-repo:network:${this.peerId}`)
    this.#channels = []
    this.adapters.forEach(a => this.addNetworkAdapter(a))
  }

  addNetworkAdapter(networkAdapter: NetworkAdapter) {
    networkAdapter.connect(this.peerId)

    networkAdapter.on("peer-candidate", ({ peerId, channelId }) => {
      this.#log(`peer candidate: ${peerId} `)

      if (!this.#adaptersByPeer[peerId]) {
        // TODO: handle losing a server here
        this.#adaptersByPeer[peerId] = networkAdapter
      }

      this.emit("peer", { peerId, channelId })
    })

    networkAdapter.on("peer-disconnected", ({ peerId }) => {
      this.#log(`peer disconnected: ${peerId} `)
      delete this.#adaptersByPeer[peerId]
      this.emit("peer-disconnected", { peerId })
    })

    networkAdapter.on("message", msg => {
      const { senderId, channelId, broadcast, message } = msg
      this.#log(`message from ${senderId}`)

      // If we receive a broadcast message from a network adapter we need to re-broadcast it to all
      // our other peers. This is the world's worst gossip protocol.

      // TODO: This relies on the network forming a tree! If there are cycles, this approach will
      // loop messages around forever.
      if (broadcast) {
        Object.entries(this.#adaptersByPeer)
          .filter(([id]) => id !== senderId)
          .forEach(([id, peer]) => {
            peer.sendMessage(id as PeerId, channelId, message, broadcast)
          })
      }

      // HACK -- the name of the auth channel isn't something we should know or care about
      if (channelId === "auth_channel") return

      this.emit("message", msg)
    })

    networkAdapter.on("error", payload => {
      const { peerId, channelId, error } = payload
      this.#log(`adapter error %o`, { peerId, channelId, error: error.message })
      this.emit("error", payload)
    })

    networkAdapter.on("close", () => {
      this.#log("adapter closed")
      Object.entries(this.#adaptersByPeer).forEach(([peerId, other]) => {
        if (other === networkAdapter) {
          delete this.#adaptersByPeer[peerId as PeerId]
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
      Object.entries(this.#adaptersByPeer).forEach(([id, peer]) => {
        this.#log(`sending broadcast to ${id}`)
        peer.sendMessage(id as PeerId, channelId, message, true)
      })
    } else {
      const peer = this.#adaptersByPeer[peerId]
      if (!peer) {
        this.#log(`Tried to send message but peer not found: ${peerId}`)
        return
      }
      this.#log(`Sending message to ${peerId}`)
      peer.sendMessage(peerId, channelId, message, false)
    }
  }

  join(channelId: ChannelId) {
    this.#log(`Joining channel ${channelId}`)
    this.#channels.push(channelId)
    this.adapters.forEach(a => a.join(channelId))
  }

  leave(channelId: ChannelId) {
    this.#log(`Leaving channel ${channelId}`)
    this.#channels = this.#channels.filter(c => c !== channelId)
    this.adapters.forEach(a => a.leave(channelId))
  }
}

function randomPeerId() {
  return `user-${Math.round(Math.random() * 100000)}` as PeerId
}

// events & payloads

export interface NetworkSubsystemEvents {
  peer: (payload: PeerPayload) => void
  "peer-disconnected": (payload: PeerDisconnectedPayload) => void
  message: (payload: InboundMessagePayload) => void
  error: (payload: ErrorPayload) => void
}

export interface PeerPayload {
  peerId: PeerId
  channelId: ChannelId
}

export interface ErrorPayload {
  peerId: PeerId
  channelId: ChannelId
  error: Error
}
