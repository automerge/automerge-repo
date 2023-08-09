import { ChannelId, NetworkAdapter, PeerId } from "@automerge/automerge-repo"

export class BroadcastChannelNetworkAdapter extends NetworkAdapter {
  #broadcastChannel: BroadcastChannel

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
          this.#announceConnection(senderId)
          break
        case "welcome":
          this.#announceConnection(senderId)
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

  #announceConnection(peerId: PeerId) {
    this.emit("peer-candidate", { peerId })
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

  join() {
    this.#broadcastChannel.postMessage({
      senderId: this.peerId,
      type: "arrive",
      broadcast: true,
    })
  }

  leave() {
    // TODO
    throw new Error("Unimplemented: leave on BroadcastChannelNetworkAdapter")
  }
}
