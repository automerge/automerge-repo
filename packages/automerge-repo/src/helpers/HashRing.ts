export class HashRing {
  #ring: (string | null)[]
  #seen = new Set<string>()
  #focus = 0

  constructor(private capacity: number) {
    this.#ring = Array(capacity).fill(null)
  }

  has(hash: string): boolean {
    return this.#seen.has(hash)
  }

  add(hash: string): boolean {
    if (this.has(hash)) return false

    const toEvict = this.#ring[this.#focus]
    if (toEvict !== null) this.#seen.delete(toEvict)
    this.#seen.add(hash)

    this.#ring[this.#focus] = hash
    this.#focus = (this.#focus + 1) % this.#ring.length

    return true
  }

  size() {
    return this.#seen.size
  }
}
