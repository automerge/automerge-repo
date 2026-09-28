/**
 * Holds items strongly for a while after their last activity.
 *
 * Two generations rotated by one unref'd interval of `periodMs`: an item
 * touched during a period is released between one and two periods after
 * its last touch. With `periodMs = Infinity` the interval never runs and
 * items are held until {@link KeepAlive.delete}, {@link KeepAlive.trimTo}
 * or {@link KeepAlive.clear}. Within a generation, items are kept in order
 * of last touch. Each item carries a size, and {@link KeepAlive.trimTo}
 * releases the least recently touched items to fit a budget.
 *
 * @internal
 */
export class KeepAlive<T> {
  #periodMs: number
  #current = new Map<T, number>()
  #previous = new Map<T, number>()
  #totalSize = 0
  #timer: ReturnType<typeof setInterval> | undefined

  constructor(periodMs: number) {
    this.#periodMs = periodMs
  }

  /** Mark `item` active now, with its current `size`. */
  touch(item: T, size = 0): void {
    this.delete(item)
    this.#current.set(item, size)
    this.#totalSize += size
    this.#startTimer()
  }

  /** Update the size of `item` if it is held. */
  resize(item: T, size: number): void {
    const generation = this.#current.has(item)
      ? this.#current
      : this.#previous.has(item)
        ? this.#previous
        : undefined
    if (!generation) return
    this.#totalSize += size - generation.get(item)!
    generation.set(item, size)
  }

  /** Stop holding `item`. */
  delete(item: T): void {
    for (const generation of [this.#previous, this.#current]) {
      const size = generation.get(item)
      if (size === undefined) continue
      generation.delete(item)
      this.#totalSize -= size
    }
  }

  /** Release the least recently touched items until the total size fits. */
  trimTo(maxSize: number): void {
    for (const item of this.leastRecentFirst()) {
      if (this.#totalSize <= maxSize) return
      this.delete(item)
    }
  }

  /** Stop holding everything and stop the timer. */
  clear(): void {
    this.#previous.clear()
    this.#current.clear()
    this.#totalSize = 0
    this.#stopTimer()
  }

  get size(): number {
    return this.#previous.size + this.#current.size
  }

  /** Sum of the sizes of the held items. */
  get totalSize(): number {
    return this.#totalSize
  }

  /** Held items, least recently touched first. */
  *leastRecentFirst(): IterableIterator<T> {
    yield* Array.from(this.#previous.keys())
    yield* Array.from(this.#current.keys())
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
    for (const size of this.#previous.values()) this.#totalSize -= size
    this.#previous = this.#current
    this.#current = new Map()
    if (this.#previous.size === 0) this.#stopTimer()
  }
}
