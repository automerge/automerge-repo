import EventEmitter from "eventemitter3"
import {
  InboundMessagePayload,
  NetworkAdapter,
  PeerDisconnectedPayload,
} from "./NetworkAdapter.js"
import { ChannelId, PeerId } from "../types.js"

import debug from "debug"

export class NetworkSubsystem extends EventEmitter<NetworkSubsystemEvents> {
  #log: debug.Debugger
  #adaptersByPeer: Record<PeerId, NetworkAdapter> = {}

  constructor(
    private adapters: NetworkAdapter[],
    public peerId = randomPeerId()
  ) {
    super()
    this.#log = debug(`automerge-repo:network:${this.peerId}`)
    this.adapters.forEach(a => this.addNetworkAdapter(a))
  }

  addNetworkAdapter(networkAdapter: NetworkAdapter) {
    networkAdapter.connect(this.peerId)

    networkAdapter.on("peer-candidate", ({ peerId }) => {
      this.#log(`peer candidate: ${peerId} `)

      // TODO: This is where authentication would happen

      if (!this.#adaptersByPeer[peerId]) {
        // TODO: handle losing a server here
        this.#adaptersByPeer[peerId] = networkAdapter
      }

      this.emit("peer", { peerId })
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

      this.emit("message", msg)
    })

    networkAdapter.on("close", () => {
      this.#log("adapter closed")
      Object.entries(this.#adaptersByPeer).forEach(([peerId, other]) => {
        if (other === networkAdapter) {
          delete this.#adaptersByPeer[peerId as PeerId]
        }
      })
    })

    networkAdapter.join()
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

  join() {
    this.#log(`Joining network`)
    this.adapters.forEach(a => a.join())
  }

  leave() {
    this.#log(`Leaving network`)
    this.adapters.forEach(a => a.leave())
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
}

export interface PeerPayload {
  peerId: PeerId
}
