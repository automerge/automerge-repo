import { EventEmitter } from "eventemitter3"
import { MessageContents, RepoMessage } from "../network/messages.js"

export abstract class Synchronizer extends EventEmitter<SynchronizerEvents> {
  abstract receiveMessage(message: RepoMessage): void
}

export interface SynchronizerEvents {
  message: (arg: MessageContents) => void
}
