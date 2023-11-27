import { EventEmitter } from "eventemitter3"

/** Returns a promise that resolves when the given event is emitted on the given emitter. */
export const eventPromise = (emitter: EventEmitter, event: string) =>
  new Promise<any>(resolve => emitter.once(event, d => resolve(d)))

export const eventPromises = (emitters: EventEmitter[], event: string) => {
  const promises = emitters.map(emitter => eventPromise(emitter, event))
  return Promise.all(promises)
}
