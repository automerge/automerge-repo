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
  Message,
  NetworkAdapter,
  PeerId,
  RepoMessage,
} from "@automerge/automerge-repo"

export type BroadcastChannelNetworkAdapterOptions = {
  channelName: string
}

export class BroadcastChannelNetworkAdapter extends NetworkAdapter {
  #broadcastChannel: BroadcastChannel

  #options: BroadcastChannelNetworkAdapterOptions

  constructor(options?: BroadcastChannelNetworkAdapterOptions) {
    super()
    this.#options = { ...(options ?? {}), channelName: "broadcast" }
  }

  connect(peerId: PeerId) {
    this.peerId = peerId
    this.#broadcastChannel = new BroadcastChannel(this.#options.channelName)

    this.#broadcastChannel.addEventListener(
      "message",
      (e: { data: Message }) => {
        const message = e.data
        if ("targetId" in message && message.targetId !== this.peerId) {
          return
        }

        const { senderId, type } = message

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
          default:
            if (!("data" in message)) {
              this.emit("message", message)
            } else {
              this.emit("message", {
                ...message,
                data: new Uint8Array(message.data),
              })
            }
            break
        }
      }
    )

    this.#broadcastChannel.postMessage({
      senderId: this.peerId,
      type: "arrive",
    })

    this.emit("ready", { network: this })
  }

  #announceConnection(peerId: PeerId) {
    this.emit("peer-candidate", { peerId })
  }

  send(message: RepoMessage) {
    if ("data" in message) {
      this.#broadcastChannel.postMessage({
        ...message,
        data: message.data.buffer.slice(
          message.data.byteOffset,
          message.data.byteOffset + message.data.byteLength
        ),
      })
    } else {
      this.#broadcastChannel.postMessage(message)
    }
  }

  disconnect() {
    // TODO:
    throw new Error("Unimplemented: leave on BroadcastChannelNetworkAdapter")
  }
}
