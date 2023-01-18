import EventEmitter from "eventemitter3"

export const eventPromise = (emitter: EventEmitter, event: string) =>
  new Promise<any>(resolve => emitter.once(event, d => resolve(d)))
