/**
 * A `NetworkAdapter` which uses [`MessageChannel`](https://developer.mozilla.org/en-US/docs/Web/API/MessageChannel)
 * to communicate with other peers. This is useful for communicating between
 * browser tabs and web workers (including shared workers).
 *
 * @module
 */
import {
  type RepoMessage,
  NetworkAdapter,
  type PeerId,
  type Message,
  PeerMetadata,
} from "@automerge/automerge-repo/slim"
import { MessagePortRef } from "./MessagePortRef.js"
import { StrongMessagePortRef } from "./StrongMessagePortRef.js"
import { WeakMessagePortRef } from "./WeakMessagePortRef.js"

import debug from "debug"
const log = debug("automerge-repo:messagechannel")

export class MessageChannelNetworkAdapter extends NetworkAdapter {
  channels = {}
  /** @hidden */
  messagePortRef: MessagePortRef

  #ready = false
  #readyResolver?: () => void
  #readyPromise: Promise<void> = new Promise<void>(resolve => {
    this.#readyResolver = resolve
  })
  #remotePeerId?: PeerId

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

  constructor(
    messagePort: MessagePort,
    config: MessageChannelNetworkAdapterConfig = {}
  ) {
    super()

    const useWeakRef = config.useWeakRef ?? false

    this.messagePortRef = useWeakRef
      ? new WeakMessagePortRef(messagePort)
      : new StrongMessagePortRef(messagePort)
  }

  connect(peerId: PeerId, peerMetadata?: PeerMetadata) {
    log("messageport connecting")
    this.peerId = peerId
    this.peerMetadata = peerMetadata

    this.messagePortRef.start()
    this.messagePortRef.addListener(
      "message",
      (e: { data: MessageChannelMessage }) => {
        log("message port received %o", e.data)

        const message = e.data
        if ("targetId" in message && message.targetId !== this.peerId) {
          throw new Error(
            "MessagePortNetwork should never receive messages for a different peer."
          )
        }

        const { senderId, type } = message

        switch (type) {
          case "arrive":
            {
              const { peerMetadata } = message as ArriveMessage
              this.messagePortRef.postMessage({
                type: "welcome",
                senderId: this.peerId,
                peerMetadata: this.peerMetadata,
                targetId: senderId,
              })
              this.announceConnection(senderId, peerMetadata)
            }
            break
          case "welcome":
            {
              const { peerMetadata } = message as WelcomeMessage
              this.announceConnection(senderId, peerMetadata)
            }
            break
          case "leave":
            if (this.#remotePeerId === senderId) {
              this.emit("peer-disconnected", { peerId: senderId })
            }
            break
          default:
            if (!("data" in message)) {
              this.emit("message", message)
            } else {
              this.emit("message", {
                ...message,
                data: message.data ? new Uint8Array(message.data) : undefined,
              })
            }
            break
        }
      }
    )

    this.messagePortRef.addListener("close", () => {
      this.emit("close")
    })

    this.messagePortRef.postMessage({
      senderId: this.peerId,
      type: "arrive",
      peerMetadata,
    })

    // Mark this messagechannel as ready after 50 ms, at this point there
    // must be something weird going on on the other end to cause us to receive
    // no response
    setTimeout(() => {
      this.#forceReady()
    }, 100)
  }

  send(message: RepoMessage) {
    if ("data" in message) {
      const data = message.data.buffer.slice(
        message.data.byteOffset,
        message.data.byteOffset + message.data.byteLength
      )

      this.messagePortRef.postMessage(
        {
          ...message,
          data,
        },
        [data]
      )
    } else {
      this.messagePortRef.postMessage(message)
    }
  }

  announceConnection(peerId: PeerId, peerMetadata: PeerMetadata) {
    this.#remotePeerId = peerId
    this.#forceReady()
    this.emit("peer-candidate", { peerId, peerMetadata })
  }

  disconnect() {
    if (this.#remotePeerId && this.peerId) {
      this.messagePortRef.postMessage({
        type: "leave",
        senderId: this.peerId,
      })
      this.emit("peer-disconnected", { peerId: this.#remotePeerId })
    }
    this.messagePortRef.stop()
  }
}

export interface MessageChannelNetworkAdapterConfig {
  /**
   * This is an optional parameter to use a weak ref to reference the message port that is passed to
   * the adapter. This option is useful when using a message channel with a shared worker. If you
   * use a network adapter with `useWeakRef = true` in the shared worker and in the main thread
   * network adapters with strong refs the network adapter will be automatically garbage collected
   * if you close a page. The garbage collection doesn't happen immediately; there might be some
   * time in between when the page is closed and when the port is garbage collected
   */
  useWeakRef?: boolean
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

type MessageChannelMessage = ArriveMessage | WelcomeMessage | Message
