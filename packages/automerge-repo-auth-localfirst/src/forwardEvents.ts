import { EventEmitter } from "eventemitter3"

/** Forwards the given list of events from one EventEmitter to another of the same type */
export const forwardEvents = <T extends EventEmitter.ValidEventTypes>(
  source: EventEmitter<T>,
  target: EventEmitter<T>,
  events: EventEmitter.EventNames<T>[]
) => {
  type Listener = EventEmitter.EventListener<T, EventEmitter.EventNames<T>>
  type Args = Parameters<Listener>

  events.forEach(e => {
    const listener = ((...args: Args) => {
      target.emit(e, ...args)
    }) as Listener
    source.on(e, listener)
  })
}
