import EventEmitter from "eventemitter3"
import {
  ChannelId,
  NetworkAdapter,
  NetworkAdapterEvents,
  PeerId,
} from "automerge-repo"

export class BroadcastChannelNetworkAdapter
  extends EventEmitter<NetworkAdapterEvents>
  implements NetworkAdapter
{
  channels = {}
  peerId?: PeerId

  connect(peerId: PeerId) {
    this.peerId = peerId
  }

  announceConnection(
    channelId: ChannelId,
    peerId: PeerId,
    broadcastChannel: BroadcastChannel
  ) {
    // return a peer object
    const connection = {
      close: () => {
        /* noop */
      } /* not sure what it would mean to close this yet */,
      isOpen: () => true,
      send: (channelId, uint8message: Uint8Array) => {
        const message = uint8message.buffer.slice(
          uint8message.byteOffset,
          uint8message.byteOffset + uint8message.byteLength
        )
        broadcastChannel.postMessage({
          origin: this.peerId,
          destination: peerId,
          type: "message",
          message,
        })
      },
    }
    this.emit("peer-candidate", { peerId, channelId, connection })
  }

  join(channelId: ChannelId) {
    const broadcastChannel = new BroadcastChannel(`doc-${channelId}`)
    broadcastChannel.postMessage({ origin: this.peerId, type: "arrive" })
    broadcastChannel.addEventListener("message", (e) => {
      const { origin, destination, type, message } = e.data
      if (destination && destination !== this.peerId) {
        return
      }
      switch (type) {
        case "arrive":
          broadcastChannel.postMessage({
            origin: this.peerId,
            destination: origin,
            type: "welcome",
          })
          this.announceConnection(channelId, origin, broadcastChannel)
          break
        case "welcome":
          this.announceConnection(channelId, origin, broadcastChannel)
          break
        case "message":
          this.emit("message", {
            peerId: origin,
            channelId,
            message: new Uint8Array(message),
          })
          break
        default:
          throw new Error("unhandled message from network")
      }
    })
  }

  leave(channelId: ChannelId) {
    // TODO
    throw new Error(
      "Unimplemented: leave on BroadcastChannelNetworkAdapter: " + channelId
    )
  }
}
