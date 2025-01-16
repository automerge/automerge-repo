/**
 *
 * A `NetworkAdapter` which uses [BroadcastChannel](https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel)
 * to communicate with other peers in the same browser tab. This is a bit of a
 * hack because `NetworkAdapter`s are supposed to be used as point to
 * point communication channels. To get around this the {@link BroadcastChannelNetworkAdapter}
 * broadcasts messages to all peers and then filters out messages not intended
 * for the current peer. This is quite inefficient as messages get duplicated
 * for every peer in the tab, but as it's all local communication anyway
 * it's not too bad. If efficiency is becoming an issue you can switch to
 * `automerge-repo-network-messagechannel`.
 *
 * @module
 *
 */

import {
  NetworkAdapter,
  type Message,
  type PeerId,
  type PeerMetadata,
} from "@automerge/automerge-repo/slim"

export type BroadcastChannelNetworkAdapterOptions = {
  channelName: string
}

export class BroadcastChannelNetworkAdapter extends NetworkAdapter {
  #broadcastChannel: BroadcastChannel
  #disconnected = false

  #options: BroadcastChannelNetworkAdapterOptions

  #ready = false
  #readyResolver?: () => void
  #readyPromise: Promise<void> = new Promise<void>(resolve => {
    this.#readyResolver = resolve
  })
  #connectedPeers: PeerId[] = []

  isReady() {
    return this.#ready
  }

  whenReady() {
    return this.#readyPromise
  }

  #forceReady() {
    if (!this.#ready) {
      this.#ready = true
      this.#readyResolver?.()
    }
  }

  constructor(options?: BroadcastChannelNetworkAdapterOptions) {
    super()
    this.#options = { channelName: "broadcast", ...(options ?? {}) }
    this.#broadcastChannel = new BroadcastChannel(this.#options.channelName)
  }

  connect(peerId: PeerId, peerMetadata?: PeerMetadata) {
    this.peerId = peerId
    this.peerMetadata = peerMetadata
    this.#disconnected = false

    this.#broadcastChannel.addEventListener(
      "message",
      (e: { data: BroadcastChannelMessage }) => {
        const message = e.data
        if ("targetId" in message && message.targetId !== this.peerId) {
          return
        }

        if (this.#disconnected) {
          return
        }

        const { senderId, type } = message

        switch (type) {
          case "arrive":
            {
              const { peerMetadata } = message as ArriveMessage
              this.#broadcastChannel.postMessage({
                senderId: this.peerId,
                targetId: senderId,
                type: "welcome",
                peerMetadata: this.peerMetadata,
              })
              this.#announceConnection(senderId, peerMetadata)
            }
            break
          case "welcome":
            {
              const { peerMetadata } = message as WelcomeMessage
              this.#announceConnection(senderId, peerMetadata)
            }
            break
          case "leave":
            this.#connectedPeers = this.#connectedPeers.filter(
              p => p !== senderId
            )
            this.emit("peer-disconnected", { peerId: senderId })
            break
          default:
            if (!("data" in message)) {
              this.emit("message", message)
            } else {
              if (!message.data) {
                throw new Error(
                  "We got a message without data, we can't send this."
                )
              }
              const data = message.data
              this.emit("message", {
                ...message,
                data: new Uint8Array(data),
              })
            }
            break
        }
      }
    )

    this.#broadcastChannel.postMessage({
      senderId: this.peerId,
      type: "arrive",
      peerMetadata,
    })
  }

  #announceConnection(peerId: PeerId, peerMetadata: PeerMetadata) {
    this.#forceReady()
    this.#connectedPeers.push(peerId)
    this.emit("peer-candidate", { peerId, peerMetadata })
  }

  send(message: Message) {
    if (this.#disconnected) {
      return false
    }
    if ("data" in message) {
      this.#broadcastChannel.postMessage({
        ...message,
        data: message.data
          ? message.data.buffer.slice(
              message.data.byteOffset,
              message.data.byteOffset + message.data.byteLength
            )
          : undefined,
      })
    } else {
      this.#broadcastChannel.postMessage(message)
    }
  }

  disconnect() {
    this.#broadcastChannel.postMessage({
      senderId: this.peerId,
      type: "leave",
    })
    for (const peerId of this.#connectedPeers) {
      this.emit("peer-disconnected", { peerId })
    }
    this.#disconnected = true
  }
}

/** Notify the network that we have arrived so everyone knows our peer ID */
type ArriveMessage = {
  type: "arrive"

  /** The peer ID of the sender of this message */
  senderId: PeerId

  /** The peer metadata of the sender of this message */
  peerMetadata: PeerMetadata

  /** Arrive messages don't have a targetId */
  targetId: never
}

/** Respond to an arriving peer with our peer ID */
type WelcomeMessage = {
  type: "welcome"

  /** The peer ID of the recipient sender this message */
  senderId: PeerId

  /** The peer metadata of the sender of this message */
  peerMetadata: PeerMetadata

  /** The peer ID of the recipient of this message */
  targetId: PeerId
}

type BroadcastChannelMessage = ArriveMessage | WelcomeMessage | Message
