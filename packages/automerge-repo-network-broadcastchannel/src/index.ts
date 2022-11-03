import EventEmitter from "eventemitter3"
import {
  ALL_PEERS_ID,
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

  sendMessage(peerId: PeerId, channelId: ChannelId, uint8message: Uint8Array) {
    const message = uint8message.buffer.slice(
      uint8message.byteOffset,
      uint8message.byteOffset + uint8message.byteLength
    )
    this.broadcastChannels[channelId].postMessage({
      origin: this.peerId,
      destination: peerId,
      type: "message",
      message,
    })
  }

  join(channelId: ChannelId) {
    const broadcastChannel = new BroadcastChannel(`doc-${channelId}`)
    broadcastChannel.postMessage({ origin: this.peerId, type: "arrive" })
    broadcastChannel.addEventListener("message", (e) => {
      const { origin, destination, type, message } = e.data
      if ((destination && destination !== this.peerId) || ALL_PEERS_ID) {
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
