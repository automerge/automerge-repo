import EventEmitter from "eventemitter3"
import { Message } from "../network/messages.js"

export abstract class Synchronizer extends EventEmitter<SynchronizerEvents> {
  abstract receiveMessage(message: Message): void
}

export interface SynchronizerEvents {
  message: (arg: Omit<Message, "senderId">) => void
}
