/** A storage adapter for binary data used by the Subduction backend.
 *
 * @remarks
 * Provides a key/value interface with string keys and byte-array values.
 */
export interface ByteStore {
  load(key: string): Promise<Uint8Array | undefined>

  /** One consistent read, in input order. */
  loadMany(keys: readonly string[]): Promise<(Uint8Array | undefined)[]>

  /** Atomically replace a value. */
  save(key: string, data: Uint8Array): Promise<void>

  /** All entries become visible together, or none do. */
  saveBatch(entries: readonly [key: string, data: Uint8Array][]): Promise<void>

  /** Ignore missing keys. */
  remove(key: string): Promise<void>

  /** Removes every key, or none; missing keys are ignored. */
  removeBatch(keys: readonly string[]): Promise<void>

  /** Atomically remove keys with this prefix (all keys if empty). */
  removeRange(prefix: string): Promise<void>

  /** Sorted full keys beginning with prefix. */
  list(prefix: string): Promise<string[]>

  /** Sorted entries under prefix, from one consistent read. */
  loadPrefix(prefix: string): Promise<[key: string, data: Uint8Array][]>
}
