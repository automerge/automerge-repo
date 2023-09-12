/** A storage adapter represents some way of storing binary data for a {@link Repo}
 *
 * @remarks
 * `StorageAdapter`s are a little like a key/value store. The keys are arrays
 * of strings ({@link StorageKey}) and the values are binary blobs.
 */
export abstract class StorageAdapter {
  // load, store, or remove a single binary blob based on an array key
  // automerge-repo mostly uses keys in the following form:
  // [documentId, "snapshot"] or [documentId, "incremental", "0"]
  // but the storage adapter is agnostic to the meaning of the key
  // and we expect to store other data in the future such as syncstates
  /** Load the single blob correspongind to `key` */
  abstract load(key: StorageKey): Promise<Uint8Array | undefined>
  /** save the blod `data` to the key `key` */
  abstract save(key: StorageKey, data: Uint8Array): Promise<void>
  /** remove the blob corresponding to `key` */
  abstract remove(key: StorageKey): Promise<void>

  // the keyprefix will match any key that starts with the given array
  // for example, [documentId, "incremental"] will match all incremental saves
  // or [documentId] will match all data for a given document
  // be careful! this will also match [documentId, "syncState"]!
  // (we aren't using this yet but keep it in mind.)
  /** Load all blobs with keys that start with `keyPrefix` */
  abstract loadRange(keyPrefix: StorageKey): Promise<{key: StorageKey, data: Uint8Array}[]>
  /** Remove all blobs with keys that start with `keyPrefix` */
  abstract removeRange(keyPrefix: StorageKey): Promise<void>
}

/** The type of keys for a {@link StorageAdapter}
 *
 * @remarks
 * Storage keys are arrays because they are hierarchical and the storage 
 * subsystem will need to be able to do range queries for all keys that
 * have a particular prefix. For example, incremental changes for a given
 * document might be stored under `[<documentId>, "incremental", <SHA256>]`.
 * `StorageAdapter` implementations should not assume any particular structure
 * though.
 **/
export type  StorageKey = string[]
