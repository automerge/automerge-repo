import EventEmitter from "eventemitter3"
import {
  ChannelId,
  NetworkAdapter,
  NetworkAdapterEvents,
  PeerId,
} from "automerge-repo"
import debug from "debug"
const log = debug("messagechannel")

interface PortRefEvents {
  message: (event: MessageEvent) => void
  close: () => void
}

interface MessagePortRef extends EventEmitter<PortRefEvents> {
  start (): void
  postMessage (message: any, transferable?: Transferable[]): void
  isAlive () : boolean
}

class WeakMessagePortRef extends EventEmitter<PortRefEvents> implements MessagePortRef {

  private weakRef : WeakRef<MessagePort>
  private isDisconnected = false

  constructor(port: MessagePort) {
    super()

    this.weakRef = new WeakRef<MessagePort>(port)

    port.addEventListener("message", (event) => {
      this.emit("message", event)
    })
  }

  postMessage(message: any, transfer: Transferable[]): void {
    const port = this.weakRef.deref()

    if (!port) {
      this.disconnnect()
      return
    }

    try {
      port.postMessage(message, transfer);
    } catch (err) {
      this.disconnnect()
    }
  }

  start(): void {
    const port = this.weakRef.deref()

    if (!port) {
      this.disconnnect()
      return
    }

    try {
      port.start();
    } catch (err) {
      this.disconnnect()
    }
  }

  private disconnnect() {
    if (!this.isDisconnected) {
      this.emit("close");
      this.isDisconnected = true;
    }
  }

  isAlive(): boolean {
    if (this.isDisconnected) {
      return false
    }

    if (!this.weakRef.deref()) {
      this.disconnnect()
      return false
    }

    return true;
  }
}

class StrongMessagePortRef extends EventEmitter<PortRefEvents> implements MessagePortRef {
  constructor(private port: MessagePort) {
    port.addEventListener("message", (event) => {
      this.emit("message", event)
    })

    super()
  }

  postMessage(message: any, transfer: Transferable[]): void {
    this.port.postMessage(message, transfer)
  }

  start(): void {
    this.port.start()
  }

  isAlive(): boolean {
    return true
  }
}


export class MessageChannelNetworkAdapter
  extends EventEmitter<NetworkAdapterEvents>
  implements NetworkAdapter
{
  channels = {}
  messagePortRef: MessagePortRef
  peerId?: PeerId

  constructor(messagePort: MessagePort, useWeakRef: boolean = false) {
    super()
    this.messagePortRef = useWeakRef ? new WeakMessagePortRef(messagePort) : new StrongMessagePortRef(messagePort)
  }

  connect(peerId: PeerId) {
    log("messageport connecting")
    this.peerId = peerId
    this.messagePortRef.start()
    this.messagePortRef.addListener("message", (e) => {
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
