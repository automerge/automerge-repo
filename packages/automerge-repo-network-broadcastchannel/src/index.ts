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
  makeLogger,
  NetworkAdapter,
  type Message,
  type PeerId,
  type PeerMetadata,
} from "@automerge/automerge-repo/slim"

const log = makeLogger("automerge-repo:broadcastchannel")

export type BroadcastChannelNetworkAdapterOptions = {
  /** BroadcastChannel name to use */
  channelName: string
  /** How long to wait for peers to arrive before declaring this adapter is ready */
  peerWaitMs?: number
}

export class BroadcastChannelNetworkAdapter extends NetworkAdapter {
  #broadcastChannel: BroadcastChannel
  // Held on the instance so disconnect() can remove it and connect() can avoid
  // stacking duplicates.
  #messageListener?: (e: { data: BroadcastChannelMessage }) => void
  #disconnected = false
  #ready = false
  // reassigned in constructor, but keeps TS from complaining
  #markReady = () => {}
  #readyPromise: Promise<void>

  #options: BroadcastChannelNetworkAdapterOptions

  #connectedPeers: PeerId[] = []

  isReady() {
    return this.#ready
  }

  whenReady() {
    return this.#readyPromise
  }

  constructor(options?: BroadcastChannelNetworkAdapterOptions) {
    super()
    this.#options = {
      channelName: "broadcast",
      peerWaitMs: 1000,
      ...(options ?? {}),
    }
    this.#broadcastChannel = new BroadcastChannel(this.#options.channelName)
    this.#readyPromise = new Promise<void>(resolve => {
      this.#markReady = () => {
        this.#ready = true
        resolve()
      }
      setTimeout(() => this.#markReady(), this.#options.peerWaitMs)
    })
  }

  connect(peerId: PeerId, peerMetadata?: PeerMetadata) {
    this.peerId = peerId
    this.peerMetadata = peerMetadata

    // disconnect() closes the channel, so reopen one when reconnecting after a
    // disconnect; otherwise detach the current listener before re-adding so we
    // never stack duplicates.
    if (this.#disconnected) {
      this.#broadcastChannel = new BroadcastChannel(this.#options.channelName)
    } else if (this.#messageListener) {
      this.#broadcastChannel.removeEventListener(
        "message",
        this.#messageListener
      )
    }
    this.#disconnected = false

    this.#messageListener = (e: { data: BroadcastChannelMessage }) => {
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
              // A throw inside this "message" listener escapes dispatch and can
              // crash the process under Node, so log and drop the malformed
              // message.
              log.warn("dropping a data message with no data from %o", senderId)
              return
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
    this.#broadcastChannel.addEventListener("message", this.#messageListener)

    this.#broadcastChannel.postMessage({
      senderId: this.peerId,
      type: "arrive",
      peerMetadata,
    })
  }

  #announceConnection(peerId: PeerId, peerMetadata: PeerMetadata) {
    this.#markReady()
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
    // Idempotent: a second disconnect() must not post on / close the channel
    // again (closing it makes a further postMessage throw).
    if (this.#disconnected) {
      return
    }
    this.#broadcastChannel.postMessage({
      senderId: this.peerId,
      type: "leave",
    })
    for (const peerId of this.#connectedPeers) {
      this.emit("peer-disconnected", { peerId })
    }
    this.#disconnected = true

    // Detach the listener and close the channel so nothing is retained after
    // disconnect; connect() reopens a fresh channel.
    if (this.#messageListener) {
      this.#broadcastChannel.removeEventListener(
        "message",
        this.#messageListener
      )
      this.#messageListener = undefined
    }
    this.#broadcastChannel.close()
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
