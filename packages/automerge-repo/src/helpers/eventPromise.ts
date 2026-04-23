import { EventEmitter } from "eventemitter3"

// `EventEmitter<any, any>` is used here (rather than the default
// `EventEmitter<string | symbol>`) so that subclasses which narrow their
// event types — e.g. `DocHandle<T>` with `DocHandleEvents<T>` — remain
// structurally assignable.
type AnyEmitter = EventEmitter<any, any>

/** Returns a promise that resolves when the given event is emitted on the given emitter. */
export const eventPromise = (emitter: AnyEmitter, event: string) =>
  new Promise<any>(resolve => emitter.once(event, d => resolve(d)))

export const eventPromises = (emitters: AnyEmitter[], event: string) => {
  const promises = emitters.map(emitter => eventPromise(emitter, event))
  return Promise.all(promises)
}
