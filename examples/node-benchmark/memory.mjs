import { performance } from "node:perf_hooks"

/** One indexed, copying byte store; only the key/API shape differs by target. */
export class MemoryStore {
  #data = new Map()
  #keys = new Map()
  #buckets = new Map()
  #stats = new Map()

  constructor() {
    this.resetStats()
  }

  resetStats() {
    this.#stats = new Map(
      [
        "load",
        "save",
        "remove",
        "loadRange",
        "removeRange",
        "saveBatch",
        "list",
        "loadPrefix",
      ].map(op => [op, { calls: 0, elapsedMs: 0, values: 0 }])
    )
  }

  stats() {
    return Object.fromEntries(this.#stats)
  }

  size() {
    return {
      keys: this.#data.size,
      bytes: [...this.#data.values()].reduce(
        (sum, bytes) => sum + bytes.length,
        0
      ),
    }
  }

  async #measure(op, work) {
    const started = performance.now()
    try {
      const result = work()
      if (Array.isArray(result)) this.#stats.get(op).values += result.length
      return result
    } finally {
      const stat = this.#stats.get(op)
      stat.calls++
      stat.elapsedMs += performance.now() - started
    }
  }

  #bucket(key) {
    // Legacy storage shards by document ID; Subduction by tree ID.
    if (Array.isArray(key))
      return key[0] === "subduction" && key.length >= 3 ? key[2] : key[0]
    return key.split("/").slice(0, 2).join("/")
  }

  #encode(key) {
    return Array.isArray(key) ? JSON.stringify(key) : key
  }

  #put(key, bytes) {
    const encoded = this.#encode(key)
    const bucket = this.#bucket(key)
    if (!this.#data.has(encoded)) {
      if (!this.#buckets.has(bucket)) this.#buckets.set(bucket, [])
      const keys = this.#buckets.get(bucket)
      let low = 0
      let high = keys.length
      while (low < high) {
        const mid = (low + high) >>> 1
        if (keys[mid] < encoded) low = mid + 1
        else high = mid
      }
      keys.splice(low, 0, encoded)
      this.#keys.set(encoded, Array.isArray(key) ? key.slice() : key)
    }
    this.#data.set(encoded, bytes.slice())
  }

  #delete(key) {
    const encoded = this.#encode(key)
    if (!this.#data.delete(encoded)) return
    this.#keys.delete(encoded)
    const bucket = this.#bucket(key)
    const keys = this.#buckets.get(bucket)
    keys.splice(keys.indexOf(encoded), 1)
    if (!keys.length) this.#buckets.delete(bucket)
  }

  #entries(prefix) {
    const fullScan =
      prefix.length === 0 ||
      (Array.isArray(prefix) &&
        prefix[0] === "subduction" &&
        prefix.length < 3) ||
      (!Array.isArray(prefix) && prefix.split("/").length < 3)
    const keys = fullScan
      ? this.#data.keys()
      : (this.#buckets.get(this.#bucket(prefix)) ?? [])
    const matching = []
    for (const encoded of keys) {
      const key = this.#keys.get(encoded)
      const matches = Array.isArray(prefix)
        ? prefix.every((part, i) => key[i] === part)
        : key.startsWith(prefix)
      if (matches)
        matching.push([
          Array.isArray(key) ? key.slice() : key,
          this.#data.get(encoded).slice(),
        ])
    }
    // Buckets are kept sorted during seeding; fallback full-store reads are rare.
    return fullScan
      ? matching.sort(([a], [b]) =>
          this.#encode(a).localeCompare(this.#encode(b))
        )
      : matching
  }

  // The same backing/index/copy rules serve both versioned adapter interfaces.
  legacy() {
    return {
      load: key =>
        this.#measure("load", () => this.#data.get(this.#encode(key))?.slice()),
      save: (key, bytes) => this.#measure("save", () => this.#put(key, bytes)),
      remove: key => this.#measure("remove", () => this.#delete(key)),
      loadRange: prefix =>
        this.#measure("loadRange", () =>
          this.#entries(prefix).map(([key, data]) => ({ key, data }))
        ),
      removeRange: prefix =>
        this.#measure("removeRange", () => {
          for (const [key] of this.#entries(prefix)) this.#delete(key)
        }),
      saveBatch: entries =>
        this.#measure("saveBatch", () => {
          for (const [key, data] of entries) this.#put(key, data)
        }),
    }
  }

  bytes() {
    return {
      load: key => this.#measure("load", () => this.#data.get(key)?.slice()),
      save: (key, bytes) => this.#measure("save", () => this.#put(key, bytes)),
      saveBatch: entries =>
        this.#measure("saveBatch", () => {
          for (const [key, data] of entries) this.#put(key, data)
        }),
      remove: key => this.#measure("remove", () => this.#delete(key)),
      list: prefix =>
        this.#measure("list", () => this.#entries(prefix).map(([key]) => key)),
      loadPrefix: prefix =>
        this.#measure("loadPrefix", () => this.#entries(prefix)),
    }
  }
}
