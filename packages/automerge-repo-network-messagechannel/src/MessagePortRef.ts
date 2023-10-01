import type { EventEmitter } from "eventemitter3"

export interface PortRefEvents {
  message: (event: MessageEvent) => void
  close: () => void
}

export interface MessagePortRef extends EventEmitter<PortRefEvents> {
  start(): void
  postMessage(message: any, transferable?: Transferable[]): void
  isAlive(): boolean
}
