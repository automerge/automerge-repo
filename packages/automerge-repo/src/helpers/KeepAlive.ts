/**
 * Holds items strongly for a while after their last activity.
 *
 * Two generations rotated by one unref'd interval of `periodMs`: an item
 * touched during a period is released between one and two periods after
 * its last touch. With `periodMs = Infinity` the interval never runs and
 * items are held until {@link KeepAlive.delete} or {@link KeepAlive.clear}.
 * Within a generation, items are kept in order of last touch.
 *
 * @internal
 */
export class KeepAlive<T> {
  #periodMs: number
  #current = new Set<T>()
  #previous = new Set<T>()
  #timer: ReturnType<typeof setInterval> | undefined

  constructor(periodMs: number) {
    this.#periodMs = periodMs
  }

  /** Mark `item` active now. */
  touch(item: T): void {
    this.#previous.delete(item)
    // Re-insert so the generation stays ordered by last touch.
    this.#current.delete(item)
    this.#current.add(item)
    this.#startTimer()
  }

  /** Stop holding `item`. */
  delete(item: T): void {
    this.#previous.delete(item)
    this.#current.delete(item)
  }

  /** Stop holding everything and stop the timer. */
  clear(): void {
    this.#previous.clear()
    this.#current.clear()
    this.#stopTimer()
  }

  get size(): number {
    return this.#previous.size + this.#current.size
  }

  /** Held items, least recently touched first. */
  *leastRecentFirst(): IterableIterator<T> {
    yield* this.#previous
    yield* this.#current
  }

  #startTimer(): void {
    if (this.#timer !== undefined || !Number.isFinite(this.#periodMs)) return
    this.#timer = setInterval(() => this.#rotate(), this.#periodMs)
    // Never keep the process alive just to release memory.
    if (typeof this.#timer === "object") this.#timer.unref?.()
  }

  #stopTimer(): void {
    if (this.#timer === undefined) return
    clearInterval(this.#timer)
    this.#timer = undefined
  }

  #rotate(): void {
    this.#previous = this.#current
    this.#current = new Set()
    if (this.#previous.size === 0) this.#stopTimer()
  }
}
