/**
 * A single-consumer queue: an initial cut, then live values in push order.
 * Unlike an async generator blocked in await, return() immediately wakes a
 * pending next(). Neither abandoning initial enumeration nor closing while idle
 * leaves a pinned snapshot behind.
 */
export class Observation<T> implements AsyncIterableIterator<T> {
  #initial?: Iterator<T>
  #live: T[] = []
  #done = false
  #terminal?: T
  #pending?: { resolve: (result: IteratorResult<T>) => void }

  constructor(
    initial: Iterator<T>,
    private readonly copy: (value: T) => T,
    private onEnd: (() => void) | undefined
  ) {
    this.#initial = initial
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this
  }

  push(value: T): void {
    if (this.#done) return
    this.#live.push(value)
    this.#wake()
  }

  next(): Promise<IteratorResult<T>> {
    if (this.#pending)
      return Promise.reject(
        new Error("An observation permits only one outstanding next()")
      )
    const result = this.#read()
    if (result) return Promise.resolve(result)
    return new Promise(resolve => {
      this.#pending = { resolve }
    })
  }

  return(): Promise<IteratorResult<T>> {
    this.#terminal = undefined
    this.end()
    return Promise.resolve({ done: true, value: undefined })
  }

  /** An invalidating event, such as deletion, supersedes queued old-generation data. */
  end(terminal?: T): void {
    if (this.#done) return
    this.#done = true
    this.#terminal = terminal
    this.#initial?.return?.()
    this.#initial = undefined
    this.#live = []
    const onEnd = this.onEnd
    this.onEnd = undefined
    onEnd?.()
    this.#wake()
  }

  #read(): IteratorResult<T> | undefined {
    if (this.#terminal !== undefined) {
      const value = this.#terminal
      this.#terminal = undefined
      return { done: false, value: this.copy(value) }
    }
    if (this.#done) return { done: true, value: undefined }
    if (this.#initial) {
      const next = this.#initial.next()
      if (!next.done) return { done: false, value: this.copy(next.value) }
      this.#initial = undefined
    }
    if (!this.#live.length) return undefined
    return { done: false, value: this.copy(this.#live.shift()!) }
  }

  #wake(): void {
    if (!this.#pending) return
    const pending = this.#pending
    this.#pending = undefined
    const result = this.#read()
    if (result) pending.resolve(result)
    else this.#pending = pending
  }
}
