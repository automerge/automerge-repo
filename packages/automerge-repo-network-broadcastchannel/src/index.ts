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
  broadcastChannels: { [channelId: ChannelId]: BroadcastChannel }
  peerId?: PeerId

  connect(peerId: PeerId) {
    this.peerId = peerId
  }

  announceConnection(channelId: ChannelId, peerId: PeerId) {
    this.emit("peer-candidate", { peerId, channelId })
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
    this.broadcastChannels[channelId].postMessage({
      origin: this.peerId,
      destination: peerId,
      type: "message",
      message,
      broadcast,
    })
  }

  join(channelId: ChannelId) {
    const broadcastChannel = new BroadcastChannel(`doc-${channelId}`)
    broadcastChannel.postMessage({ origin: this.peerId, type: "arrive" })
    broadcastChannel.addEventListener("message", (e) => {
      const { origin, destination, type, message, broadcast } = e.data
      // TODO: this logic is no good, we're gonna get event amplification from this
      //       but since we don't have tests... and i'm not using it...
      if ((destination && destination !== this.peerId) || !broadcast) {
        return
      }
      switch (type) {
        case "arrive":
          broadcastChannel.postMessage({
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

  leave(channelId: ChannelId) {
    // TODO
    throw new Error(
      "Unimplemented: leave on BroadcastChannelNetworkAdapter: " + channelId
    )
  }
}
