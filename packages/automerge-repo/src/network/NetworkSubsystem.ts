import EventEmitter from "eventemitter3"
import {
  EphemeralMessage,
  Message,
  MessagePayload,
  MessageType,
  PeerId,
  SyncMessage,
} from "../types.js"
import { NetworkAdapter, PeerDisconnectedPayload } from "./NetworkAdapter.js"

import debug from "debug"

export class NetworkSubsystem extends EventEmitter<NetworkSubsystemEvents> {
  #log: debug.Debugger
  #adaptersByPeer: Record<PeerId, NetworkAdapter> = {}

  constructor(private adapters: NetworkAdapter[], public peerId: PeerId) {
    super()
    this.#log = debug(`automerge-repo:network:${this.peerId}`)
    this.adapters.forEach(a => this.addNetworkAdapter(a))
  }

  addNetworkAdapter(networkAdapter: NetworkAdapter) {
    networkAdapter.connect(this.peerId)

    networkAdapter.on("peer-candidate", ({ peerId, channelId }) => {
      this.#log(`peer candidate: ${peerId} `)

      // TODO: This is where authentication would happen

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

    networkAdapter.on("message", message => {
      const { senderId } = message
      this.#log(`message from ${senderId}`)

      // If we receive an ephemeral message from a network adapter we need to re-broadcast it to all
      // our other peers. This is the world's worst gossip protocol.

      // TODO: This relies on the network forming a tree! If there are cycles, this approach will
      // loop messages around forever.
      if (message.type === "EPHEMERAL_MESSAGE") {
        Object.entries(this.#adaptersByPeer)
          .filter(([id]) => id !== senderId) // Don't send the message back to the original sender
          .forEach(([id, peer]) => {
            peer.sendMessage(message)
          })
      }

      // we emit the message so the Repo can handle it
      this.emit("message", message)
    })

    networkAdapter.on("close", () => {
      this.#log("adapter closed")
      Object.entries(this.#adaptersByPeer).forEach(([peerId, other]) => {
        if (other === networkAdapter) {
          delete this.#adaptersByPeer[peerId as PeerId]
        }
      })
    })
  }

  sendMessage({
    type,
    payload,
    recipientId,
    broadcast = false,
  }: Omit<Message, "senderId">) {
    const message = {
      type,
      payload,
      senderId: this.peerId,
      recipientId,
      broadcast,
    } as Message

    switch (message.type) {
      case "SYNC_MESSAGE": {
        // Send message to a specific peer
        const peer = this.#adaptersByPeer[recipientId]
        if (!peer) {
          // TODO: This should never happen — shouldn't we throw an error instead?
          this.#log(`Tried to send message but peer not found: ${recipientId}`)
          return
        }
        this.#log(`Sending message to ${recipientId}`)
        peer.sendMessage(message)
        break
      }
      case "EPHEMERAL_MESSAGE": {
        // Broadcast message to all peers
        Object.entries(this.#adaptersByPeer).forEach(([recipientId, peer]) => {
          this.#log(`sending broadcast to ${recipientId}`)
          peer.sendMessage(message)
        })
        break
      }
    }
  }
}

// events & payloads

export interface NetworkSubsystemEvents {
  peer: (payload: PeerPayload) => void
  "peer-disconnected": (payload: PeerDisconnectedPayload) => void
  message: (payload: Message) => void
}

export interface PeerPayload {
  peerId: PeerId
  channelId: string // TODO
}
