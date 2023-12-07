import { EventEmitter } from "eventemitter3"
import { pause } from "../../src/helpers/pause.js"

export async function waitForMessages(
  emitter: EventEmitter,
  event: string,
  timeout: number = 100
): Promise<any[]> {
  const messages = []

  const onEvent = message => {
    messages.push(message)
  }

  emitter.on(event, onEvent)

  await pause(timeout)

  emitter.off(event)

  return messages
}
