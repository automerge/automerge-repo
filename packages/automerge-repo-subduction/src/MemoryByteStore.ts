import type { LocalByteStore } from "./storage.js"

/** Process-local byte store for a standalone, offline Subduction backend. */
export class MemoryByteStore implements LocalByteStore {
  #data = new Map<string, Uint8Array>()
  // Sorted index of #data's keys, so prefix reads cost the size of the result
  // rather than a scan of the whole store.
  #keys: string[] = []

  async load(key: string): Promise<Uint8Array | undefined> {
    return this.#data.get(key)?.slice()
  }

  async save(key: string, bytes: Uint8Array): Promise<void> {
    if (!this.#data.has(key)) this.#keys.splice(this.#lowerBound(key), 0, key)
    this.#data.set(key, bytes.slice())
  }

  async remove(key: string): Promise<void> {
    if (this.#data.delete(key)) this.#keys.splice(this.#lowerBound(key), 1)
  }

  async list(prefix: string): Promise<string[]> {
    return this.#range(prefix)
  }

  async loadPrefix(prefix: string): Promise<[string, Uint8Array][]> {
    // Collect keys and copy values synchronously, so concurrent writes can't
    // interleave and the result is one consistent cut.
    return this.#range(prefix).map(key => [key, this.#data.get(key)!.slice()])
  }

  /** Keys starting with `prefix` are contiguous in sorted order. */
  #range(prefix: string): string[] {
    const keys: string[] = []
    for (let i = this.#lowerBound(prefix); i < this.#keys.length; i++) {
      if (!this.#keys[i].startsWith(prefix)) break
      keys.push(this.#keys[i])
    }
    return keys
  }

  #lowerBound(key: string): number {
    let low = 0
    let high = this.#keys.length
    while (low < high) {
      const mid = (low + high) >>> 1
      if (this.#keys[mid] < key) low = mid + 1
      else high = mid
    }
    return low
  }
}
