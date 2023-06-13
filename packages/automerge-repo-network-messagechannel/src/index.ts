import { Message, NetworkAdapter } from "automerge-repo"
import { decode, encode } from "cbor-x"
import { MessagePortRef } from "./MessagePortRef.js"
import { StrongMessagePortRef } from "./StrongMessagePortRef.js"
import { WeakMessagePortRef } from "./WeakMessagePortRef.js"

export class MessageChannelNetworkAdapter extends NetworkAdapter {
  channels = {}
  messagePort: MessagePortRef

  constructor(messagePort: MessagePort, { useWeakRef = false }: Config = {}) {
    super()

    this.messagePort = useWeakRef
      ? new WeakMessagePortRef(messagePort)
      : new StrongMessagePortRef(messagePort)

    this.messagePort.start()
    this.messagePort.addListener("message", e => {
      const message = decode(e.data) as Message
      this.emit("message", message)
    })

    this.messagePort.addListener("close", () => {
      this.emit("close")
    })
  }

  send(message: Message) {
    const encodedMessage = bufferToArray(encode(message))
    this.messagePort.postMessage(encodedMessage, [encodedMessage])
  }
}

interface Config {
  /**
   * You can optionally use a weak ref to reference the message port that is passed to the adapter.
   *
   * This is useful when using a message channel with a shared worker. If the shared worker's
   * adapter has a weak ref, and the main thread's adapters have strong refs, then when you close a
   * page , the network adapter will be automatically garbage-collected.
   */
  useWeakRef?: boolean
}

function bufferToArray(uint8message: Buffer | Uint8Array) {
  return uint8message.buffer.slice(
    uint8message.byteOffset,
    uint8message.byteOffset + uint8message.byteLength
  )
}
