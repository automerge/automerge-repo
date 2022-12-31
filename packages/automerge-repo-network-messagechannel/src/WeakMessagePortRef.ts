import EventEmitter from "eventemitter3"
import { PortRefEvents, MessagePortRef } from "./MessagePortRef"

export class WeakMessagePortRef
  extends EventEmitter<PortRefEvents>
  implements MessagePortRef
{
  private weakRef: WeakRef<MessagePort>
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
      port.postMessage(message, transfer)
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
      port.start()
    } catch (err) {
      this.disconnnect()
    }
  }

  private disconnnect() {
    if (!this.isDisconnected) {
      this.emit("close")
      this.isDisconnected = true
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

    return true
  }
}
