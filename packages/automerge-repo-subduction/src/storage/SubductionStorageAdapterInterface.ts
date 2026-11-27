/** A key/value storage adapter for the Subduction backend.
 *
 * @remarks
 * Keys are backend-owned ASCII strings; values are opaque bytes. Returned
 * bytes are owned by the caller, and supplied bytes must not be mutated.
 * Successful resolution means recoverable under the adapter's documented
 * guarantees (not necessarily fsync).
 */
export interface SubductionStorageAdapterInterface {
  /** One consistent read, in input order; missing values are `undefined`. */
  loadMany(keys: readonly string[]): Promise<(Uint8Array | undefined)[]>

  /** Sorted entries whose key starts with `prefix`, from one consistent read. */
  loadPrefix(prefix: string): Promise<[key: string, data: Uint8Array][]>

  /** Sorted full keys beginning with `prefix`. */
  list(prefix: string): Promise<string[]>

  /** All entries become visible together, or none do; each replaces its key. */
  saveBatch(entries: readonly [key: string, data: Uint8Array][]): Promise<void>

  /** Removes every key, or none; missing keys are ignored. */
  removeBatch(keys: readonly string[]): Promise<void>

  /** Atomically remove keys with this prefix (all keys if empty). */
  removeRange(prefix: string): Promise<void>
}
