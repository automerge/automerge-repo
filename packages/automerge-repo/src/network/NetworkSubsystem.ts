import debug from "debug"
import { EventEmitter } from "eventemitter3"
import { PeerId, SessionId } from "../types.js"
import type {
  NetworkAdapterInterface,
  PeerDisconnectedPayload,
  PeerMetadata,
} from "./NetworkAdapterInterface.js"
import {
  EphemeralMessage,
  MessageContents,
  RepoMessage,
  isEphemeralMessage,
  isRepoMessage,
} from "./messages.js"

type EphemeralMessageSource = `${PeerId}:${SessionId}`

const getEphemeralMessageSource = (message: EphemeralMessage) =>
  `${message.senderId}:${message.sessionId}` as EphemeralMessageSource

export class NetworkSubsystem extends EventEmitter<NetworkSubsystemEvents> {
  #log: debug.Debugger
  #adaptersByPeer: Record<PeerId, NetworkAdapterInterface> = {}

  #count = 0
  #sessionId: SessionId = Math.random().toString(36).slice(2) as SessionId
  #ephemeralSessionCounts: Record<EphemeralMessageSource, number> = {}
  adapters: NetworkAdapterInterface[] = []

  constructor(
    adapters: NetworkAdapterInterface[],
    public peerId: PeerId,
    private peerMetadata: Promise<PeerMetadata>
  ) {
    super()
    this.#log = debug(`automerge-repo:network:${this.peerId}`)
    adapters.forEach(a => this.addNetworkAdapter(a))
  }

  disconnect() {
    this.adapters.forEach(a => a.disconnect())
  }

  reconnect() {
    this.adapters.forEach(a => a.connect(this.peerId))
  }

  addNetworkAdapter(networkAdapter: NetworkAdapterInterface) {
    this.adapters.push(networkAdapter)

    networkAdapter.on("peer-candidate", ({ peerId, peerMetadata }) => {
      this.#log(`peer candidate: ${peerId} `)
      // TODO: This is where authentication would happen

      // TODO: on reconnection, this would create problems!
      // the server would see a reconnection as a late-arriving channel
      // for an existing peer and decide to ignore it until the connection
      // times out: turns out my ICE/SIP emulation laziness did not pay off here
      if (!this.#adaptersByPeer[peerId]) {
        // TODO: handle losing a server here
        this.#adaptersByPeer[peerId] = networkAdapter
      }

      this.emit("peer", { peerId, peerMetadata })
    })

    networkAdapter.on("peer-disconnected", ({ peerId }) => {
      this.#log(`peer disconnected: ${peerId} `)
      delete this.#adaptersByPeer[peerId]
      this.emit("peer-disconnected", { peerId })
    })

    networkAdapter.on("message", msg => {
      if (!isRepoMessage(msg)) {
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
      this.adapters = this.adapters.filter(a => a !== networkAdapter)
    })

    this.peerMetadata
      .then(peerMetadata => {
        networkAdapter.connect(this.peerId, peerMetadata)
      })
      .catch(err => {
        this.#log("error connecting to network", err)
      })
  }

  // TODO: this probably introduces a race condition for the ready event
  // but I plan to refactor that as part of this branch in another patch
  removeNetworkAdapter(networkAdapter: NetworkAdapterInterface) {
    this.adapters = this.adapters.filter(a => a !== networkAdapter)
    networkAdapter.disconnect()
  }

  send(message: MessageContents) {
    const peer = this.#adaptersByPeer[message.targetId]
    if (!peer) {
      this.#log(`Tried to send message but peer not found: ${message.targetId}`)
      return
    }

    /** Messages come in without a senderId and other required information; this is where we make
     * sure they have everything they need.
     */
    const prepareMessage = (message: MessageContents): RepoMessage => {
      if (message.type === "ephemeral") {
        if ("count" in message) {
          // existing ephemeral message from another peer; pass on without changes
          return message as EphemeralMessage
        } else {
          // new ephemeral message from us; add our senderId as well as a counter and session id
          return {
            ...message,
            count: ++this.#count,
            sessionId: this.#sessionId,
            senderId: this.peerId,
          } as EphemeralMessage
        }
      } else {
        // other message type; just add our senderId
        return {
          ...message,
          senderId: this.peerId,
        } as RepoMessage
      }
    }

    const outbound = prepareMessage(message)
    this.#log("sending message %o", outbound)
    peer.send(outbound as RepoMessage)
  }

  isReady = () => {
    return this.adapters.every(a => a.isReady())
  }

  whenReady = async () => {
    return Promise.all(this.adapters.map(a => a.whenReady()))
  }
}

// events & payloads

export interface NetworkSubsystemEvents {
  peer: (payload: PeerPayload) => void
  "peer-disconnected": (payload: PeerDisconnectedPayload) => void
  message: (payload: RepoMessage) => void
}

export interface PeerPayload {
  peerId: PeerId
  peerMetadata: PeerMetadata
}
