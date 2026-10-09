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
    this.#put(key, bytes.slice())
  }

  async saveBatch(entries: readonly [string, Uint8Array][]): Promise<void> {
    // Copy everything first; then apply synchronously, so readers see all
    // entries or none.
    const copies = entries.map(([key, bytes]) => [key, bytes.slice()] as const)
    for (const [key, bytes] of copies) this.#put(key, bytes)
  }

  #put(key: string, bytes: Uint8Array): void {
    if (!this.#data.has(key)) this.#keys.splice(this.#lowerBound(key), 0, key)
    this.#data.set(key, bytes)
  }

  async remove(key: string): Promise<void> {
    if (this.#data.delete(key)) this.#keys.splice(this.#lowerBound(key), 1)
  }

  async removeBatch(keys: readonly string[]): Promise<void> {
    // Applied synchronously, so readers see all removals or none.
    for (const key of keys)
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
