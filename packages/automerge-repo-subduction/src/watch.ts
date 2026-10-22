/** Single-consumer observation queue, not a history store. Initial-load
 * events are readable as they arrive; live events queue until pulled. */
export class Watch<T> implements AsyncIterable<T>, AsyncIterator<T> {
  private initial: T[] = []
  private initialIndex = 0
  private live: T[] = []
  private ready = false
  private buffering = false
  private ended = false
  private claimed = false
  private pulling = false
  private wake?: () => void
  active = false

  constructor(
    private readonly copy: (value: T) => T,
    private readonly released: () => void
  ) {}

  [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.claimed) throw new Error("Observation has one consumer")
    this.claimed = true
    return this
  }
  /** Buffer live notifications before a non-atomic initial read completes. */
  bufferBeforeInitialize(): void {
    if (!this.ended) this.buffering = true
  }
  /** Deliver an initial-load event ahead of buffered live notifications. */
  pushInitial(value: T): void {
    if (this.ended || this.ready) return
    this.initial.push(value)
    this.wake?.()
  }
  /** End the initial load with `values`, then release live notifications. */
  initialize(values: T[]): void {
    if (this.ended) return
    this.initial.push(...values)
    this.ready = true
    this.active = true
    this.buffering = false
    this.wake?.()
  }
  push(value: T): void {
    if (this.ended || (!this.active && !this.buffering)) return
    this.live.push(value)
    this.wake?.()
  }
  finish(final?: T): void {
    if (this.ended) return
    this.ended = true
    this.active = false
    this.buffering = false
    this.initial = final === undefined ? [] : [final]
    this.initialIndex = 0
    this.live = []
    this.ready = true
    this.released()
    this.wake?.()
  }
  async next(): Promise<IteratorResult<T>> {
    if (this.pulling) throw new Error("Only one pending next() is permitted")
    this.pulling = true
    try {
      for (;;) {
        if (this.initialIndex < this.initial.length) {
          const value = this.initial[this.initialIndex++]
          if (this.initialIndex === this.initial.length) {
            this.initial = []
            this.initialIndex = 0
          }
          return { done: false, value: this.copy(value) }
        }
        if (this.ready) {
          if (this.live.length)
            return { done: false, value: this.copy(this.live.shift()!) }
          if (this.ended) return { done: true, value: undefined }
        }
        await new Promise<void>(resolve => {
          this.wake = resolve
        })
        this.wake = undefined
      }
    } finally {
      this.pulling = false
    }
  }
  async return(): Promise<IteratorResult<T>> {
    this.finish()
    // Discard even a previously queued terminal event on explicit release.
    this.initial = []
    return { done: true, value: undefined }
  }
}
