/**
 * Map keyed by a primitive (`number | string`) where values are held weakly.
 * Dead entries are removed automatically via `FinalizationRegistry` once the
 * value is GC'd.
 *
 * Use for pure optimization caches where:
 *   - the key is a primitive (e.g. a stringified path, a stringified head, a
 *     document id),
 *   - V can be cheaply reconstructed on miss,
 *   - "cache hit" is never observable as program state.
 *
 * Why not `WeakMap`? `WeakMap` keys must be `WeakKey` (object or registered
 * symbol). It cannot be keyed on a `number` or a `string` — try
 * `new WeakMap<string, T>()` and TypeScript rejects it. `WeakValueMap` fills
 * exactly that gap: primitive keys, weak values, with the same automatic
 * eviction guarantee that `WeakMap` provides for object keys.
 *
 * If your key *is* an object, prefer the built-in `WeakMap` instead — it ships
 * with the language and has cleaner lifetime semantics for that shape.
 *
 * @example
 *   // Cache view handles by stringified heads.
 *   const cache = new WeakValueMap<string, DocHandle<T>>()
 *   const handle = cache.getOrCompute(JSON.stringify(heads), () => makeView(heads))
 */
export class WeakValueMap<K extends number | string, V extends WeakKey> {
  #map = new Map<K, WeakRef<V>>()
  #registry = new FinalizationRegistry<K>(key => {
    const ref = this.#map.get(key)
    if (ref !== undefined && ref.deref() === undefined) {
      this.#map.delete(key)
    }
  })

  get(key: K): V | undefined {
    return this.#map.get(key)?.deref()
  }

  set(key: K, value: V): this {
    const existing = this.#map.get(key)?.deref()
    if (existing !== undefined) {
      // Without this, the old value's finalizer would later delete the new
      // entry. The value object itself is the unregister token.
      this.#registry.unregister(existing)
    }
    this.#map.set(key, new WeakRef(value))
    this.#registry.register(value, key, value)
    return this
  }

  delete(key: K): boolean {
    const existing = this.#map.get(key)?.deref()
    if (existing !== undefined) this.#registry.unregister(existing)
    return this.#map.delete(key)
  }

  has(key: K): boolean {
    return this.get(key) !== undefined
  }

  getOrCompute(key: K, compute: () => V): V {
    const existing = this.get(key)
    if (existing !== undefined) return existing
    const value = compute()
    this.set(key, value)
    return value
  }
}
