import type { LocalByteStore } from "./storage.js"

/** Process-local byte store for a standalone, offline Subduction backend. */
export class MemoryByteStore implements LocalByteStore {
  #data = new Map<string, Uint8Array>()

  async load(key: string): Promise<Uint8Array | undefined> {
    return this.#data.get(key)?.slice()
  }

  async save(key: string, bytes: Uint8Array): Promise<void> {
    this.#data.set(key, bytes.slice())
  }

  async remove(key: string): Promise<void> {
    this.#data.delete(key)
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.#data.keys()].filter(key => key.startsWith(prefix)).sort()
  }

  async loadPrefix(prefix: string): Promise<[string, Uint8Array][]> {
    // Collect keys and copy values synchronously, so concurrent writes can't
    // interleave and the result is one consistent cut.
    return [...this.#data]
      .filter(([key]) => key.startsWith(prefix))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => [key, value.slice()])
  }
}
