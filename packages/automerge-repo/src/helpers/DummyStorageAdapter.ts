import {
  Chunk,
  StorageAdapterInterface,
  type StorageKey,
} from "../../src/index.js"

export class DummyStorageAdapter implements StorageAdapterInterface {
  #data: Record<string, Uint8Array> = Object.create(null)

  // First-segment index over stored keys, so `loadRange` is O(keys for
  // that document) instead of O(total keys). The full scan made bulk
  // workloads quadratic in test benches — N docs × O(N·keys) scans —
  // masking the (linear) behavior of the production adapters, which
  // already index (nodefs: prefix trie; IDB: native key ranges).
  // `loadRange` prefixes always start with a whole first segment
  // (document id), matching how the production adapters shard.
  #index: Map<string, Set<string>> = new Map()

  #keyToString(key: string[]): string {
    return key.join(".")
  }

  #stringToKey(key: string): string[] {
    return key.split(".")
  }

  async loadRange(keyPrefix: StorageKey): Promise<Chunk[]> {
    const prefix = this.#keyToString(keyPrefix)
    const candidates =
      keyPrefix.length === 0
        ? Object.keys(this.#data)
        : (this.#index.get(keyPrefix[0]) ?? [])

    const range: Chunk[] = []
    for (const key of candidates) {
      if (key.startsWith(prefix)) {
        range.push({ key: this.#stringToKey(key), data: this.#data[key] })
      }
    }
    return Promise.resolve(range)
  }

  async removeRange(keyPrefix: string[]): Promise<void> {
    for (const chunk of await this.loadRange(keyPrefix)) {
      this.#delete(this.#keyToString(chunk.key))
    }
  }

  async load(key: string[]): Promise<Uint8Array | undefined> {
    return new Promise(resolve => resolve(this.#data[this.#keyToString(key)]))
  }

  async save(key: string[], binary: Uint8Array) {
    const joined = this.#keyToString(key)
    this.#data[joined] = binary

    let bucket = this.#index.get(key[0])
    if (bucket === undefined) {
      bucket = new Set()
      this.#index.set(key[0], bucket)
    }
    bucket.add(joined)
    return Promise.resolve()
  }

  async remove(key: string[]) {
    this.#delete(this.#keyToString(key))
  }

  async saveBatch(entries: Array<[StorageKey, Uint8Array]>): Promise<void> {
    for (const [key, data] of entries) {
      await this.save(key, data)
    }
  }

  keys() {
    return Object.keys(this.#data)
  }

  #delete(joined: string): void {
    delete this.#data[joined]
    const first = this.#stringToKey(joined)[0]
    const bucket = this.#index.get(first)
    if (bucket !== undefined) {
      bucket.delete(joined)
      if (bucket.size === 0) this.#index.delete(first)
    }
  }
}
