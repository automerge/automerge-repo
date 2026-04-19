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
     */
    saveBatch(entries: Array<[StorageKey, Uint8Array]>): Promise<void>
}
