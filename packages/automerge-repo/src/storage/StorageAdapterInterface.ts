import { StorageKey, Chunk } from "./types.js"

/** A storage adapter represents some way of storing binary data for a {@link Repo}
 *
 * @remarks
 * `StorageAdapter`s provide a key/value storage interface. The keys are arrays of strings
 * ({@link StorageKey}) and the values are binary blobs.
 */
export interface StorageAdapterInterface {
  /** Load the single value corresponding to `key` */
  load(key: StorageKey): Promise<Uint8Array | undefined>

  /** Save the value `data` to the key `key` */
  save(key: StorageKey, data: Uint8Array): Promise<void>

  /** Remove the value corresponding to `key` */
  remove(key: StorageKey): Promise<void>

  /**
   * Load all values with keys that start with `keyPrefix`.
   *
   * @remarks
   * The `keyprefix` will match any key that starts with the given array. For example:
   * - `[documentId, "incremental"]` will match all incremental saves
   * - `[documentId]` will match all data for a given document.
   *
   * Be careful! `[documentId]` would also match something like `[documentId, "syncState"]`! We
   * aren't using this yet but keep it in mind.)
   */
  loadRange(keyPrefix: StorageKey): Promise<Chunk[]>

  /** Remove all values with keys that start with `keyPrefix` */
  removeRange(keyPrefix: StorageKey): Promise<void>

  /**
   * Save multiple key-value pairs as a staged batch.
   *
   * ## Two-phase semantics
   *
   * Implementations SHOULD apply the batch in two phases:
   *
   *   1. **Stage**: every entry's value is written to durable temporary
   *      storage (e.g. tmp file + fsync). No target is observable yet.
   *   2. **Commit**: every staged write is committed to its final
   *      target (e.g. rename over target).
   *
   * If any stage operation fails, the batch is aborted before any
   * commit happens — no entries become observable.
   *
   * ## Commit-phase semantics vary by implementation
   *
   * - **Transactional implementations** (e.g. IndexedDB, where the
   *   whole batch runs inside one readwrite transaction) commit the
   *   entire batch atomically. A crash either leaves the full batch
   *   observable or none of it — never a partial prefix.
   * - **Non-transactional implementations** (e.g. NodeFS, where the
   *   commit phase is a sequence of `rename(2)` calls) may leave an
   *   arbitrary subset observable on crash. Each individual committed
   *   entry is still atomic — readers never see partial bytes for any
   *   single key — but cross-entry ordering within the commit phase
   *   is not guaranteed.
   *
   * Callers that need strict cross-entry ordering across crashes (on
   * any adapter) must split their entries across multiple sequential
   * `saveBatch` (or `save`) calls: the phase boundary between calls
   * gives them the ordering guarantee they need.
   *
   * Callers whose downstream readers tolerate partial-batch outcomes
   * (e.g. a reader that checks for a related key's presence before
   * surfacing an entry) can safely pass related keys as a single
   * `saveBatch` call — on transactional adapters they get atomicity,
   * and on non-transactional adapters the tolerated-partial case is
   * handled at read time.
   *
   * {@link StorageAdapter} provides a default implementation that
   * simply falls back to sequential {@link save} calls. The default
   * offers only per-entry atomicity — not the stage/commit separation
   * — so consumers that depend on the stage/commit semantics above
   * should require an adapter that overrides `saveBatch` explicitly.
   */
  saveBatch(entries: Array<[StorageKey, Uint8Array]>): Promise<void>
}
