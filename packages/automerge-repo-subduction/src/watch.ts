/** Single-consumer observation buffer, not a history store. Initial blob
 * delivery is one batch; only live replay uses this cap. */
export class Watch<T> implements AsyncIterable<T>, AsyncIterator<T> {
  private initial: T[] = []
  private initialIndex = 0
  private live: { value: T; bytes: number; droppable: boolean }[] = []
  private liveBytes = 0
  private ready = false
  private buffering = false
  private ended = false
  private claimed = false
  private pulling = false
  private wake?: () => void
  active = false

  constructor(
    private readonly maxEvents: number,
    private readonly maxBytes: number,
    private readonly copy: (value: T) => T,
    private readonly overflow: () => T,
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
  initialize(values: T[]): void {
    if (this.ended) return
    this.initial = values
    this.ready = true
    this.active = true
    this.buffering = false
    this.wake?.()
  }
  push(value: T, bytes = 64, droppable = false): void {
    if (this.ended || (!this.active && !this.buffering)) return
    while (
      this.live.length >= this.maxEvents ||
      this.liveBytes + bytes > this.maxBytes
    ) {
      if (droppable) return
      // Lossy traffic must not displace durable observations or force a rescan.
      const index = this.live.findIndex(entry => entry.droppable)
      if (index < 0) {
        this.finish(this.overflow())
        return
      }
      this.liveBytes -= this.live.splice(index, 1)[0].bytes
    }
    this.live.push({ value, bytes, droppable })
    this.liveBytes += bytes
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
    this.liveBytes = 0
    this.ready = true
    this.released()
    this.wake?.()
  }
  async next(): Promise<IteratorResult<T>> {
    if (this.pulling) throw new Error("Only one pending next() is permitted")
    this.pulling = true
    try {
      for (;;) {
        if (this.ready) {
          if (this.initialIndex < this.initial.length) {
            const value = this.initial[this.initialIndex++]
            if (this.initialIndex === this.initial.length) {
              this.initial = []
              this.initialIndex = 0
            }
            return { done: false, value: this.copy(value) }
          }
          const entry = this.live.shift()
          if (entry) {
            this.liveBytes -= entry.bytes
            return { done: false, value: this.copy(entry.value) }
          }
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
