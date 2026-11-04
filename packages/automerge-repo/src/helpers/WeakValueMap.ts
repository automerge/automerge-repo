import { kEntryCount } from "../internals.js"

/**
 * Map keyed by a primitive (`number | string`) where values are held weakly.
 * Dead entries are removed automatically via `FinalizationRegistry` once the
 * value is GC'd.
 *
 * Use for pure optimization caches where:
 *   - the key is a primitive
 *   - V can be cheaply reconstructed on miss,
 *   - "cache hit" is never observable as program state.
 *
 * Why not `WeakMap`? `WeakMap` keys must be `WeakKey` (object or registered
 * symbol). It cannot be keyed on a `number` or a `string`. `WeakValueMap` fills
 * that gap with the same automatic eviction guarantee that `WeakMap` provides
 * for object keys.
 *
 * @example
 *   // Cache view handles by stringified heads.
 *   const cache = new WeakValueMap<string, DocHandle<T>>()
 *   const handle = cache.getOrCompute(JSON.stringify(heads), () => makeView(heads))
 */
export class WeakValueMap<K extends number | string, V extends WeakKey> {
  #map = new Map<K, WeakRef<V>>()
  // The held value is only the primitive key: a registry retains held values
  // strongly while the target lives, so a held value must never reference the
  // target. The callback's `this` capture reaches nothing but WeakRefs, so it
  // cannot pin targets either.
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

  // Iteration matches `Map`'s shape (`entries`, `keys`, `values`,
  // `[Symbol.iterator]`). Dead entries are silently skipped — there's
  // no way to observe one, and the only way for a value to be in the
  // underlying map is to be alive at the moment we yield it.
  //
  // No `size`. The count can change between calls just from GC, so any
  // single read would be immediately stale.

  *entries(): IterableIterator<[K, V]> {
    for (const [key, ref] of this.#map) {
      const value = ref.deref()
      if (value !== undefined) yield [key, value]
    }
  }

  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.entries()
  }

  *keys(): IterableIterator<K> {
    for (const [key, ref] of this.#map) {
      if (ref.deref() !== undefined) yield key
    }
  }

  /** @internal Entries in the backing map, live or not. For tests. */
  get [kEntryCount](): number {
    return this.#map.size
  }

  *values(): IterableIterator<V> {
    for (const ref of this.#map.values()) {
      const value = ref.deref()
      if (value !== undefined) yield value
    }
  }
}
