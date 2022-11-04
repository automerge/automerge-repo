import EventEmitter from "eventemitter3"
import {
  ALL_PEERS_ID,
  ChannelId,
  NetworkAdapter,
  NetworkAdapterEvents,
  PeerId,
} from "automerge-repo"
import debug from "debug"
const log = debug("messagechannel")

export class MessageChannelNetworkAdapter
  extends EventEmitter<NetworkAdapterEvents>
  implements NetworkAdapter
{
  channels = {}
  messagePort: MessagePort
  peerId?: PeerId

  constructor(messagePort: MessagePort) {
    super()
    this.messagePort = messagePort
  }

  connect(peerId: PeerId) {
    log("messageport connecting")
    this.peerId = peerId
    this.messagePort.start()
    this.messagePort.addEventListener("message", (e) => {
      log("message port received", e.data)
      const { origin, destination, type, channelId, message, broadcast } =
        e.data
      if (
        destination &&
        !(destination === this.peerId || destination === ALL_PEERS_ID)
      ) {
        throw new Error(
          "MessagePortNetwork should never receive messages for a different peer."
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
            targetId: destination,
            channelId,
            message: new Uint8Array(message),
            broadcast,
          })
          break
        default:
          throw new Error("unhandled message from network")
      }
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
    this.messagePort.postMessage(
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
    // return a peer object
    const peer = {
      close: () => {
        /* noop */
      } /* not sure what it would mean to close this yet */,
      isOpen: () => true,
    }
    this.emit("peer-candidate", { peerId, channelId })
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
