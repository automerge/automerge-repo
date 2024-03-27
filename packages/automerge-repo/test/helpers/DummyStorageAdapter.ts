import {
  Chunk,
  StorageAdapterInterface,
  type StorageKey,
} from "../../src/index.js"

export class DummyStorageAdapter implements StorageAdapterInterface {
  #data: Record<string, Uint8Array> = {}

  #keyToString(key: string[]): string {
    return key.join(".")
  }

  #stringToKey(key: string): string[] {
    return key.split(".")
  }

  async loadRange(keyPrefix: StorageKey): Promise<Chunk[]> {
    const range = Object.entries(this.#data)
      .filter(([key, _]) => key.startsWith(this.#keyToString(keyPrefix)))
      .map(([key, data]) => ({ key: this.#stringToKey(key), data }))
    return Promise.resolve(range)
  }

  async removeRange(keyPrefix: string[]): Promise<void> {
    Object.entries(this.#data)
      .filter(([key, _]) => key.startsWith(this.#keyToString(keyPrefix)))
      .forEach(([key, _]) => delete this.#data[key])
  }

  async load(key: string[]): Promise<Uint8Array | undefined> {
    return new Promise(resolve => resolve(this.#data[this.#keyToString(key)]))
  }

  async save(key: string[], binary: Uint8Array) {
    this.#data[this.#keyToString(key)] = binary
    return Promise.resolve()
  }

  async remove(key: string[]) {
    delete this.#data[this.#keyToString(key)]
  }

  keys() {
    return Object.keys(this.#data)
  }
}
