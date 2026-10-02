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
}
