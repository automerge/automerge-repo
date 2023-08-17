import EventEmitter from "eventemitter3"
import { PeerId } from "../types.js"
import { NetworkAdapter, PeerDisconnectedPayload } from "./NetworkAdapter.js"

import {
  isEphemeralMessage,
  isValidMessage,
  Message,
  MessageContents,
} from "./messages.js"

import debug from "debug"
import { SessionId } from "../EphemeralData.js"

export class NetworkSubsystem extends EventEmitter<NetworkSubsystemEvents> {
  #log: debug.Debugger
  #adaptersByPeer: Record<PeerId, NetworkAdapter> = {}

  #count = 0
  #sessionId: SessionId = Math.random().toString(36).slice(2) as SessionId
  #ephemeralSessionCounts: Record<SessionId, number> = {}

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
      if (!isValidMessage(msg)) {
        this.#log(`invalid message: ${JSON.stringify(msg)}`)
        return
      }

      this.#log(`message from ${msg.senderId}`)

      if (isEphemeralMessage(msg)) {
        if (
          this.#ephemeralSessionCounts[msg.sessionId] === undefined ||
          msg.count > this.#ephemeralSessionCounts[msg.sessionId]
        ) {
          this.#ephemeralSessionCounts[msg.sessionId] = msg.count
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

    networkAdapter.join()
  }

  send(msg: MessageContents) {
    const message =
      "senderId" in msg
        ? (msg as MessageContents & { senderId: PeerId })
        : {
            ...msg,
            senderId: this.peerId,
          }

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
            }
      this.#log("Ephemeral message", outbound)
      peer.send(outbound)
    } else {
      this.#log("Sync message", message)
      peer.send(message)
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
  message: (payload: Message) => void
}

export interface PeerPayload {
  peerId: PeerId
}
