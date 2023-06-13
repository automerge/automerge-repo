import { NetworkAdapter, PeerId } from "automerge-repo"
import { MessagePortRef } from "./MessagePortRef.js"
import { StrongMessagePortRef } from "./StrongMessagePortRef.js"
import { WeakMessagePortRef } from "./WeakMessagePortRef.js"

import debug from "debug"
const log = debug("automerge-repo:messagechannel")

export class MessageChannelNetworkAdapter extends NetworkAdapter {
  channels = {}
  messagePortRef: MessagePortRef

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

  // NEXT: update these message types

  connect(peerId: PeerId) {
    log("messageport connecting")
    this.peerId = peerId
    this.messagePortRef.start()
    this.messagePortRef.addListener("message", e => {
      log("message port received", e.data)
      const { origin, destination, type, channelId, message, broadcast } =
        e.data

      if (destination && !(destination === this.peerId || broadcast)) {
        throw new Error(
          "MessagePortNetwork should never receive messages for a different peer."
        )
      }

      switch (type) {
        case "arrive":
          this.messagePortRef.postMessage({
            origin: this.peerId,
            destination: origin,
            type: "welcome",
          })
          this.announceConnection(channelId, origin)
          break
        case "welcome":
          this.announceConnection(channelId, origin)
          break
        case "message":
          this.emit("message", {
            type: "SYNC", // TODO
            senderId: origin,
            recipientId: destination,
            documentId: channelId,
            payload: new Uint8Array(message),
          })
          break
        default:
          throw new Error("unhandled message from network")
      }
    })

    this.messagePortRef.addListener("close", () => {
      this.emit("close")
    })
  }

  sendMessage(
    peerId: PeerId,
    channelId: ChannelId,
    uint8message: Uint8Array,
    broadcast: boolean
  ) {
    const message = uint8message.buffer.slice(
      uint8message.byteOffset,
      uint8message.byteOffset + uint8message.byteLength
    )
    this.messagePortRef.postMessage(
      {
        origin: this.peerId,
        destination: peerId,
        channelId: channelId,
        type: "message",
        message,
        broadcast,
      },
      [message]
    )
  }

  announceConnection(channelId: ChannelId, peerId: PeerId) {
    this.emit("peer-candidate", { peerId, channelId })
  }

  join(channelId: string) {
    this.messagePortRef.postMessage({
      origin: this.peerId,
      channelId,
      type: "arrive",
    })
  }

  leave(docId: string) {
    // TODO
    throw new Error(
      "Unimplemented: leave on MessagePortNetworkAdapter: " + docId
    )
  }
}

interface MessageChannelNetworkAdapterConfig {
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

// TODO
type ChannelId = string
