import EventEmitter from "eventemitter3"
import { PortRefEvents, MessagePortRef } from "./MessagePortRef"

export class StrongMessagePortRef
  extends EventEmitter<PortRefEvents>
  implements MessagePortRef
{
  constructor(private port: MessagePort) {
    port.addEventListener("message", event => {
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
