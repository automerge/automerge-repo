/**
 * Shared helpers for the real-browser storage benches
 * (`StorageBench.browser.test.ts`).
 *
 * Not a test file — the browser bench config only includes
 * `*.browser.test.ts`, and the default suite excludes both.
 */
import type {
  Chunk,
  StorageAdapterInterface,
  StorageKey,
} from "@automerge/automerge-repo"

/** Per-key-category tally: writes (`put`s) and bytes for one key namespace. */
export interface CategoryCount {
  puts: number
  bytes: number
}

export interface StorageCounts {
  /** `save()` calls. */
  save: number
  /** `saveBatch()` calls (transactions on IndexedDB). */
  saveBatch: number
  /** Total entries across all `saveBatch()` calls. */
  saveBatchEntries: number
  /** Total individual record writes: `save` + `saveBatchEntries`. ~= IDB `put`s. */
  puts: number
  /** `load()` calls. */
  load: number
  /** `loadRange()` calls. */
  loadRange: number
  remove: number
  removeRange: number
  /** Bytes handed to `save`/`saveBatch`. */
  bytesWritten: number
  /**
   * Writes + bytes grouped by the first two key segments
   * (e.g. `"subduction/commits"`), so subduction-bridge writes can be
   * isolated from the legacy snapshot/incremental storage path.
   */
  byCategory: Record<string, CategoryCount>
}

const freshCounts = (): StorageCounts => ({
  save: 0,
  saveBatch: 0,
  saveBatchEntries: 0,
  puts: 0,
  load: 0,
  loadRange: 0,
  remove: 0,
  removeRange: 0,
  bytesWritten: 0,
  byCategory: {},
})

const categoryOf = (key: StorageKey): string =>
  key.length >= 2 ? `${key[0]}/${key[1]}` : String(key[0] ?? "(empty)")

/**
 * Wraps a {@link StorageAdapterInterface} and tallies every operation so a
 * bench can assert on the number of IndexedDB writes (the metric the blob
 * inlining work is trying to cut ~50%), not just wall-clock time.
 */
export class CountingStorageAdapter implements StorageAdapterInterface {
  counts: StorageCounts = freshCounts()

  constructor(private readonly inner: StorageAdapterInterface) {}

  reset(): void {
    this.counts = freshCounts()
  }

  /**
   * Count durable records under `keyPrefix` without tallying the read. Used
   * after `flush()` to measure the final on-disk record count per category —
   * a deterministic metric (the sedimentree is content-addressed) that the
   * timing-sensitive cumulative `put` counts are not.
   */
  async countByPrefix(keyPrefix: StorageKey): Promise<number> {
    return (await this.inner.loadRange(keyPrefix)).length
  }

  #record(key: StorageKey, bytes: number): void {
    this.counts.puts++
    this.counts.bytesWritten += bytes
    const cat = categoryOf(key)
    const c = (this.counts.byCategory[cat] ??= { puts: 0, bytes: 0 })
    c.puts++
    c.bytes += bytes
  }

  load(key: StorageKey): Promise<Uint8Array | undefined> {
    this.counts.load++
    return this.inner.load(key)
  }

  save(key: StorageKey, data: Uint8Array): Promise<void> {
    this.counts.save++
    this.#record(key, data.byteLength)
    return this.inner.save(key, data)
  }

  remove(key: StorageKey): Promise<void> {
    this.counts.remove++
    return this.inner.remove(key)
  }

  saveBatch(entries: Array<[StorageKey, Uint8Array]>): Promise<void> {
    this.counts.saveBatch++
    this.counts.saveBatchEntries += entries.length
    for (const [key, data] of entries) this.#record(key, data.byteLength)
    return this.inner.saveBatch(entries)
  }

  loadRange(keyPrefix: StorageKey): Promise<Chunk[]> {
    this.counts.loadRange++
    return this.inner.loadRange(keyPrefix)
  }

  removeRange(keyPrefix: StorageKey): Promise<void> {
    this.counts.removeRange++
    return this.inner.removeRange(keyPrefix)
  }
}

/** Median of a numeric sample (linear-interpolated for even counts). */
export const median = (xs: number[]): number => {
  if (xs.length === 0) return NaN
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** Run `fn`, returning its result and elapsed wall-clock ms. */
export const timed = async <T>(fn: () => Promise<T>): Promise<[T, number]> => {
  const t0 = performance.now()
  const out = await fn()
  return [out, performance.now() - t0]
}

/** Delete an IndexedDB database by name (best-effort). */
export const deleteDatabase = (name: string): Promise<void> =>
  new Promise<void>(resolve => {
    const req = indexedDB.deleteDatabase(name)
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
    req.onblocked = () => resolve()
  })
