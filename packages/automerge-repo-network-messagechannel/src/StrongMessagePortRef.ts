import { EventEmitter } from "eventemitter3"
import { PortRefEvents, MessagePortRef } from "./MessagePortRef.js"

export class StrongMessagePortRef
  extends EventEmitter<PortRefEvents>
  implements MessagePortRef
{
  isDisconnected: boolean = false

  constructor(private port: MessagePort) {
    port.addEventListener("message", event => {
      if (!this.isDisconnected) {
        this.emit("message", event)
      }
    })

    super()
  }

  postMessage(message: any, transfer: Transferable[]): void {
    if (!this.isDisconnected) {
      this.port.postMessage(message, transfer)
    }
  }

  start(): void {
    this.isDisconnected = false
    this.port.start()
  }

  stop() {
    this.isDisconnected = true
  }

  isAlive(): boolean {
    /* c8 ignore next */
    return true
  }
}
