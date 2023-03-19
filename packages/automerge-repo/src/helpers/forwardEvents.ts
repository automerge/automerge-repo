import EventEmitter, {
  EventListener,
  EventNames,
  ValidEventTypes,
} from "eventemitter3"

// helpers

export const forwardEvents = <
  T extends ValidEventTypes,
  K extends EventNames<T>[]
>(
  source: EventEmitter<T>,
  target: EventEmitter<T>,
  events: K
) => {
  type Listener = EventListener<T, EventNames<T>>
  type Args = Parameters<Listener>

  events.forEach(e => {
    const listener = ((...args: Args) => {
      target.emit(e, ...args)
    }) as Listener
    source.on(e, listener)
  })
}
