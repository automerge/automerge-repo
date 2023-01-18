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
  #broadcastChannel: BroadcastChannel

  peerId?: PeerId

  connect(peerId: PeerId) {
    this.peerId = peerId
    this.#broadcastChannel = new BroadcastChannel(`broadcast`)

    this.#broadcastChannel.addEventListener("message", e => {
      const { senderId, targetId, type, channelId, message, broadcast } = e.data

      if (targetId && targetId !== this.peerId && !broadcast) {
        return
      }

      switch (type) {
        case "arrive":
          this.#broadcastChannel.postMessage({
            senderId: this.peerId,
            targetId: senderId,
            type: "welcome",
          })
          this.#announceConnection(channelId, senderId)
          break
        case "welcome":
          this.#announceConnection(channelId, senderId)
          break
        case "message":
          this.emit("message", {
            senderId,
            targetId,
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

  #announceConnection(channelId: ChannelId, peerId: PeerId) {
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
    this.#broadcastChannel.postMessage({
      senderId: this.peerId,
      targetId: peerId,
      type: "message",
      channelId,
      message,
      broadcast,
    })
  }

  join(joinChannelId: ChannelId) {
    this.#broadcastChannel.postMessage({
      senderId: this.peerId,
      channelId: joinChannelId,
      type: "arrive",
      broadcast: true,
    })
  }

  leave(channelId: ChannelId) {
    // TODO
    throw new Error(
      "Unimplemented: leave on BroadcastChannelNetworkAdapter: " + channelId
    )
  }
}
