import EventEmitter from "eventemitter3"
import { NetworkAdapter, NetworkAdapterEvents } from "automerge-repo"

export class MessageChannelNetworkAdapter
  extends EventEmitter<NetworkAdapterEvents>
  implements NetworkAdapter
{
  channels = {}
  messagePort: MessagePort
  peerId?: string

  constructor(messagePort: MessagePort) {
    super()
    this.messagePort = messagePort
  }

  connect(peerId: string) {
    console.log("messageport connecting")
    this.peerId = peerId
    this.messagePort.start()
    this.messagePort.addEventListener("message", (e) => {
      console.log("message port received", e.data)
      const { origin, destination, type, channelId, message } = e.data
      if (destination && destination !== this.peerId) {
        throw new Error(
          "MessagePortNetwork is point-to-point -- something is wrong"
        )
      }
      switch (type) {
        case "arrive":
          this.messagePort.postMessage({
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
            senderId: origin,
            channelId,
            message: new Uint8Array(message),
          })
          break
        default:
          throw new Error("unhandled message from network")
      }
    })
  }

  announceConnection(channelId: string, peerId: string) {
    // return a peer object
    const connection = {
      close: () => {
        /* noop */
      } /* not sure what it would mean to close this yet */,
      isOpen: () => true,
      send: (uint8message: Uint8Array) => {
        const message = uint8message.buffer.slice(
          uint8message.byteOffset,
          uint8message.byteOffset + uint8message.byteLength
        )
        this.messagePort.postMessage(
          {
            origin: this.peerId,
            destination: peerId,
            type: "message",
            message,
          },
          [message]
        )
      },
    }
    this.emit("peer-candidate", { peerId, channelId, connection })
  }

  join(channelId: string) {
    this.messagePort.postMessage({
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
