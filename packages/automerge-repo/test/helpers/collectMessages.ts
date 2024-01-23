import { EventEmitter } from "eventemitter3"
import { pause } from "../../src/helpers/pause.js"

export async function collectMessages({
  emitter,
  event,
  until = pause(100),
}: {
  emitter: EventEmitter
  event: string
  until?: Promise<unknown>
}): Promise<any[]> {
  const messages = []
  const listener = (message: unknown) => messages.push(message)
  emitter.on(event, listener)
  await until
  emitter.off(event)
  return messages
}
