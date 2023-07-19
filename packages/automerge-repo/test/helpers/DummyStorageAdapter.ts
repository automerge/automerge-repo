import { StorageAdapter } from "../../src"

export class DummyStorageAdapter implements StorageAdapter {
  #data: Record<string, Uint8Array> = {}

  #keyToString(key: string[]) {
    return key.join(".")
  }

  async loadRange(keyPrefix: string[]): Promise<Uint8Array[]> {
    const range = Object.entries(this.#data)
      .filter(([key, _]) => key.startsWith(this.#keyToString(keyPrefix)))
      .map(([_, value]) => value)
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
