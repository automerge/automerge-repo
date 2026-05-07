export class HashRing {
  #ring: (string | null)[]
  #slotByHash = new Map<string, number>()
  #focus = 0

  constructor(private capacity: number) {
    this.#ring = Array(capacity).fill(null)
  }

  has(hash: string): boolean {
    return this.#slotByHash.has(hash)
  }

  add(hash: string): boolean {
    if (this.has(hash)) return false

    const toEvict = this.#ring[this.#focus]
    if (toEvict !== null) this.#slotByHash.delete(toEvict)
    this.#slotByHash.set(hash, this.#focus)

    this.#ring[this.#focus] = hash
    this.#focus = (this.#focus + 1) % this.#ring.length

    return true
  }

  /** Remove `hash` from the ring if present. Returns true if it was. */
  delete(hash: string): boolean {
    const slot = this.#slotByHash.get(hash)
    if (slot === undefined) return false
    this.#slotByHash.delete(hash)
    this.#ring[slot] = null
    return true
  }

  size() {
    return this.#slotByHash.size
  }
}
