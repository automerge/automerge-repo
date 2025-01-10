/**
 * createSignal(initialValue)
 * A minimalist approach to providing signals.
 * Intended to plug into various web frameworks (or none at all) comfortably.
 */
export interface Signal<T> {
  set: (newValue: T) => void
  subscribe: (fn: (value: T) => void) => () => void
  peek: () => T
}

export function createSignal<T>(initialValue: T): Signal<T> {
  let currentValue = initialValue
  const subscribers = new Set<WeakRef<(value: T) => void>>()

  return {
    set: newValue => {
      currentValue = newValue
      subscribers.forEach(ref => {
        const fn = ref.deref()
        if (fn) {
          fn(newValue)
        } else {
          subscribers.delete(ref)
        }
      })
    },
    subscribe: fn => {
      const ref = new WeakRef(fn)
      subscribers.add(ref)
      return () => subscribers.delete(ref)
    },
    peek: () => currentValue,
  }
}

export function compute<T>(
  fn: (get: <U>(signal: Signal<U>) => U, prev?: T) => T
): Signal<T> {
  const accessed = new Set<Signal<unknown>>()

  const get = <U>(signal: Signal<U>) => {
    accessed.add(signal as Signal<unknown>)
    return signal.peek()
  }

  const value = fn(get, undefined)
  const result = createSignal(value)

  // Need to recompute!
  accessed.forEach(signal => {
    signal.subscribe(() => {
      result.set(fn(get, result.peek()))
    })
  })

  return result
}

/*
// TODO: move React integration into hooks package
import { useEffect, useState } from "react"

export function useSignal<T>(signal: Signal<T>): T {
  const [value, setValue] = useState(() => signal.peek())

  useEffect(() => {
    return signal.subscribe(setValue)
  }, [signal])

  return value
}

const [countSignal] = useState(() => createSignal(0));
const [nameSignal] = useState(() => createSignal(""));

// Create computed signals
const [doubledSignal] = useState(() => 
  compute(get => get(countSignal) * 2)
);

// count signal could be a function

const [messageSignal] = useState(() => 
  compute(get => {
    const name = get(nameSignal);
    const count = get(countSignal);
    if (!name) return "Enter a name to begin";
    return `Hello ${name}, you've clicked ${count} times!`;
  })
);

// QUESTIONS
// - What about cycles?
//   Is dimension tracking important?


*/
