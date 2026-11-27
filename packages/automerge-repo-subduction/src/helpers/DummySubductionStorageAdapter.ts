import type { SubductionStorageAdapterInterface } from "../storage/SubductionStorageAdapterInterface.js"

/** In-memory adapter for tests and throwaway peers; nothing survives the process. */
export class DummySubductionStorageAdapter implements SubductionStorageAdapterInterface {
  #data = new Map<string, Uint8Array>()
  // Sorted index of #data's keys, so prefix reads cost the size of the result
  // rather than a scan of the whole store.
  #keys: string[] = []

  async loadMany(keys: readonly string[]): Promise<(Uint8Array | undefined)[]> {
    return keys.map(key => this.#data.get(key)?.slice())
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

  async removeBatch(keys: readonly string[]): Promise<void> {
    // Applied synchronously, so readers see all removals or none.
    for (const key of keys)
      if (this.#data.delete(key)) this.#keys.splice(this.#lowerBound(key), 1)
  }

  async removeRange(prefix: string): Promise<void> {
    const start = this.#lowerBound(prefix)
    let end = start
    while (end < this.#keys.length && this.#keys[end].startsWith(prefix)) {
      this.#data.delete(this.#keys[end++])
    }
    this.#keys.splice(start, end - start)
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
