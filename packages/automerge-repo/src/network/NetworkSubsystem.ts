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
  #adaptersByPeer: Record<PeerId, NetworkAdapter> = {}

  constructor(private adapters: NetworkAdapter[], public peerId: PeerId) {
    super()
    this.#log = debug(`automerge-repo:network:${this.peerId}`)
    this.adapters.forEach(a => this.#addNetworkAdapter(a))
  }

  #addNetworkAdapter(networkAdapter: NetworkAdapter) {
    networkAdapter.on("message", message => {
      this.#receive(message, networkAdapter)
    })

    // Say hello. They'll say hello back, and then we have a peer.
    networkAdapter.send({ type: "HELLO", senderId: this.peerId })
  }

  #receive(message: Message, networkAdapter: NetworkAdapter) {
    if (
      "recipientId" in message &&
      message.recipientId !== undefined &&
      message.recipientId !== this.peerId
    )
      throw new Error(`Not our message: ${message.recipientId}`)

    if (message.type === "HELLO")
      this.#connect(networkAdapter, message.senderId)

    if (message.type === "EPHEMERAL") {
      this.#broadcast(message)
      // SEE: #92 Improve gossip protocol for ephemeral messages http://github.com/automerge/automerge-repo/issues/92
    }

    // pass the message on to the repo
    this.emit("message", message)
  }

  #connect(networkAdapter: NetworkAdapter, peerId: PeerId) {
    this.#adaptersByPeer[peerId] = networkAdapter

    networkAdapter.on("close", () => {
      this.#disconnect(peerId)
    })

    this.emit("peer", peerId)
  }

  #disconnect(peerId: PeerId) {
    delete this.#adaptersByPeer[peerId]
    this.emit("peer-disconnected", peerId)
  }

  #broadcast(message: Message) {
    Object.entries(this.#adaptersByPeer).forEach(([id, peer]) => {
      if (id !== message.senderId)
        // Don't send the message back to the original sender
        peer.send(message)
    })
  }

  // PUBLIC

  send(_message: Omit<SyncMessage | EphemeralMessage, "senderId">) {
    const message = {
      ..._message,
      senderId: this.peerId,
    } as SyncMessage | EphemeralMessage

    switch (message.type) {
      case "SYNC": {
        const peerId = message.recipientId
        const peer = this.#adaptersByPeer[peerId]
        if (!peer) throw new Error(`Couldn't send, peer not found: ${peerId}`)

        peer.send(message)
        break
      }
      case "EPHEMERAL": {
        this.#broadcast(message)
        break
      }
    }
  }
}

// events & payloads

export interface NetworkSubsystemEvents {
  peer: (peerId: PeerId) => void
  "peer-disconnected": (peerId: PeerId) => void
  message: (payload: Message) => void
}
