import { EventEmitter } from "eventemitter3"
import { PeerId } from "../types.js"
import { NetworkAdapter, PeerDisconnectedPayload } from "./NetworkAdapter.js"

import {
  EphemeralMessage,
  isEphemeralMessage,
  isValidMessage,
  Message,
  MessageContents,
} from "./messages.js"

import debug from "debug"
import { SessionId } from "../types.js"

type EphemeralMessageSource = `${PeerId}:${SessionId}`

const getEphemeralMessageSource = (message: EphemeralMessage) =>
  `${message.senderId}:${message.sessionId}` as EphemeralMessageSource

export class NetworkSubsystem extends EventEmitter<NetworkSubsystemEvents> {
  #log: debug.Debugger
  #adaptersByPeer: Record<PeerId, NetworkAdapter> = {}

  #count = 0
  #sessionId: SessionId = Math.random().toString(36).slice(2) as SessionId
  #ephemeralSessionCounts: Record<EphemeralMessageSource, number> = {}
  #readyAdapterCount = 0
  #adapters: NetworkAdapter[] = []

  constructor(adapters: NetworkAdapter[], public peerId = randomPeerId()) {
    super()
    this.#log = debug(`automerge-repo:network:${this.peerId}`)
    adapters.forEach(a => this.addNetworkAdapter(a))
  }

  addNetworkAdapter(networkAdapter: NetworkAdapter) {
    this.#adapters.push(networkAdapter)
    networkAdapter.once("ready", () => {
      this.#readyAdapterCount++
      this.#log(
        "Adapters ready: ",
        this.#readyAdapterCount,
        "/",
        this.#adapters.length
      )
      if (this.#readyAdapterCount === this.#adapters.length) {
        this.emit("ready")
      }
    })

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
      if (!isValidMessage(msg)) {
        this.#log(`invalid message: ${JSON.stringify(msg)}`)
        return
      }

      this.#log(`message from ${msg.senderId}`)

      if (isEphemeralMessage(msg)) {
        const source = getEphemeralMessageSource(msg)
        if (
          this.#ephemeralSessionCounts[source] === undefined ||
          msg.count > this.#ephemeralSessionCounts[source]
        ) {
          this.#ephemeralSessionCounts[source] = msg.count
          this.emit("message", msg)
        }

        return
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

    networkAdapter.connect(this.peerId)
  }

  send(message: MessageContents) {
    const peer = this.#adaptersByPeer[message.targetId]
    if (!peer) {
      this.#log(`Tried to send message but peer not found: ${message.targetId}`)
      return
    }
    this.#log(`Sending message to ${message.targetId}`)

    if (isEphemeralMessage(message)) {
      const outbound =
        "count" in message
          ? message
          : {
              ...message,
              count: ++this.#count,
              sessionId: this.#sessionId,
              senderId: this.peerId,
            }
      this.#log("Ephemeral message", outbound)
      peer.send(outbound)
    } else {
      const outbound = { ...message, senderId: this.peerId }
      this.#log("Sync message", outbound)
      peer.send(outbound)
    }
  }

  isReady = () => {
    return this.#readyAdapterCount === this.#adapters.length
  }

  whenReady = async () => {
    if (this.isReady()) {
      return
    } else {
      return new Promise<void>(resolve => {
        this.once("ready", () => {
          resolve()
        })
      })
    }
  }
}

function randomPeerId() {
  return `user-${Math.round(Math.random() * 100000)}` as PeerId
}

// events & payloads

export interface NetworkSubsystemEvents {
  peer: (payload: PeerPayload) => void
  "peer-disconnected": (payload: PeerDisconnectedPayload) => void
  message: (payload: Message) => void
  ready: () => void
}

export interface PeerPayload {
  peerId: PeerId
}
