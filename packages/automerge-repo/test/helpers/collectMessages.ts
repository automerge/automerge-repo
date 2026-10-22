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
  try {
    await until
  } finally {
    // Scoped: eventemitter3's `off(event)` with no callback would clear
    // every listener for that event, including the Repo's own.
    emitter.off(event, listener)
  }
  return messages
}
