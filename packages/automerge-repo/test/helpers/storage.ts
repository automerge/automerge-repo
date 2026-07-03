import type { StorageAdapterInterface } from "../../src/storage/StorageAdapterInterface.js"
import type { Chunk, StorageKey } from "../../src/storage/types.js"

const storageKeyToString = (key: StorageKey): string => key.join("\0")

/**
 * In-memory {@link StorageAdapterInterface} for repo restart tests.
 */
export class MemoryStorageAdapter implements StorageAdapterInterface {
  readonly #data = new Map<string, Uint8Array>()

  async load(key: StorageKey): Promise<Uint8Array | undefined> {
    return this.#data.get(storageKeyToString(key))
  }

  async save(key: StorageKey, binary: Uint8Array): Promise<void> {
    this.#data.set(storageKeyToString(key), binary)
  }

  async saveBatch(entries: Array<[StorageKey, Uint8Array]>): Promise<void> {
    for (const [key, binary] of entries) {
      await this.save(key, binary)
    }
  }

  async remove(key: StorageKey): Promise<void> {
    this.#data.delete(storageKeyToString(key))
  }

  async loadRange(keyPrefix: StorageKey): Promise<Chunk[]> {
    const prefix = storageKeyToString(keyPrefix)
    const chunks: Chunk[] = []
    for (const [key, data] of this.#data) {
      if (key.startsWith(prefix)) {
        chunks.push({ key: key.split("\0"), data })
      }
    }
    chunks.sort((left, right) =>
      storageKeyToString(left.key).localeCompare(storageKeyToString(right.key))
    )
    return chunks
  }

  async removeRange(keyPrefix: StorageKey): Promise<void> {
    const prefix = storageKeyToString(keyPrefix)
    for (const key of [...this.#data.keys()]) {
      if (key.startsWith(prefix)) {
        this.#data.delete(key)
      }
    }
  }
}

type StorageOpName =
  | "load"
  | "save"
  | "saveBatch"
  | "remove"
  | "loadRange"
  | "removeRange"

/**
 * Counts every storage adapter call. Used to assert restart recovery is read-only.
 */
export class CountingStorageAdapter implements StorageAdapterInterface {
  readonly ops: Record<StorageOpName, number> = {
    load: 0,
    save: 0,
    saveBatch: 0,
    remove: 0,
    loadRange: 0,
    removeRange: 0,
  }

  #logging: boolean

  constructor(
    private readonly _inner: StorageAdapterInterface,
    { logging }: { logging?: boolean } = {}
  ) {
    this.#logging = logging ?? false
  }

  get readOps(): number {
    return this.ops.load + this.ops.loadRange
  }

  get writeOps(): number {
    return (
      this.ops.save +
      this.ops.saveBatch +
      this.ops.remove +
      this.ops.removeRange
    )
  }

  setLogging(logging: boolean): void {
    this.#logging = logging
  }

  async load(key: StorageKey): Promise<Uint8Array | undefined> {
    if (this.#logging) {
      console.log("load", key)
    }
    this.ops.load++
    return this._inner.load(key)
  }

  async save(key: StorageKey, binary: Uint8Array): Promise<void> {
    if (this.#logging) {
      console.log("save", key)
    }
    this.ops.save++
    return this._inner.save(key, binary)
  }

  async saveBatch(entries: Array<[StorageKey, Uint8Array]>): Promise<void> {
    if (this.#logging) {
      console.log("saveBatch", entries)
    }
    this.ops.saveBatch++
    return this._inner.saveBatch(entries)
  }

  async remove(key: StorageKey): Promise<void> {
    if (this.#logging) {
      console.log("remove", key)
    }
    this.ops.remove++
    return this._inner.remove(key)
  }

  async loadRange(keyPrefix: StorageKey): Promise<Chunk[]> {
    if (this.#logging) {
      console.log("loadRange", keyPrefix)
    }
    this.ops.loadRange++
    return this._inner.loadRange(keyPrefix)
  }

  async removeRange(keyPrefix: StorageKey): Promise<void> {
    if (this.#logging) {
      console.log("removeRange", keyPrefix)
    }
    this.ops.removeRange++
    return this._inner.removeRange(keyPrefix)
  }

  resetCounters(): void {
    this.ops.load = 0
    this.ops.save = 0
    this.ops.saveBatch = 0
    this.ops.remove = 0
    this.ops.loadRange = 0
    this.ops.removeRange = 0
  }
}
