import { StorageAdapterInterface } from "./StorageAdapterInterface.js"
import { StorageKey, Chunk } from "./types.js"

/** A storage adapter represents some way of storing binary data for a {@link Repo}
 * @deprecated use {@link StorageAdapterInterface}
 *
 * @remarks
 * `StorageAdapter`s provide a key/value storage interface. The keys are arrays of strings
 * ({@link StorageKey}) and the values are binary blobs.
 */
export abstract class StorageAdapter implements StorageAdapterInterface {
  /** Load the single value corresponding to `key` */
  abstract load(key: StorageKey): Promise<Uint8Array | undefined>

  /** Save the value `data` to the key `key` */
  abstract save(key: StorageKey, data: Uint8Array): Promise<void>

  /** Remove the value corresponding to `key` */
  abstract remove(key: StorageKey): Promise<void>

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
  abstract loadRange(keyPrefix: StorageKey): Promise<Chunk[]>

  /** Remove all values with keys that start with `keyPrefix` */
  abstract removeRange(keyPrefix: StorageKey): Promise<void>
}
