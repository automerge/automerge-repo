/**
 * An LMDB {@link StorageAdapterInterface} for Node.
 *
 * LMDB fits this workload unusually well:
 *
 * - Keys are ordered, and lmdb-js's `ordered-binary` key encoding supports
 *   `string[]` keys natively with component-wise ordering — a `StorageKey`
 *   is stored as-is, and `loadRange` is a plain cursor scan with no
 *   key-encoding layer.
 * - Reads are zero-syscall memory-mapped lookups.
 * - `saveBatch` runs in a single LMDB transaction: all-or-nothing, which is
 *   strictly stronger than the interface's two-phase stage/commit contract.
 *
 * The `lmdb` package vendors and statically compiles LMDB itself — consumers
 * need no system packages. Prebuilt binaries cover the mainstream platforms;
 * elsewhere npm falls back to compiling with node-gyp.
 *
 * @example
 * ```ts
 * import { Repo } from "@automerge/automerge-repo"
 * import { LMDBStorageAdapter } from "@automerge/automerge-repo-storage-lmdb"
 *
 * const repo = new Repo({
 *   storage: new LMDBStorageAdapter("./data/automerge"),
 * })
 * ```
 *
 * @packageDocumentation
 */

import { open, type RootDatabase } from "lmdb"
import type {
  Chunk,
  StorageAdapterInterface,
  StorageKey,
} from "@automerge/automerge-repo/slim"

/** Options forwarded to lmdb-js `open` (minus `path`, which is the first
 * constructor argument). See the lmdb-js documentation for the full set. */
export type LMDBStorageAdapterOptions = Omit<
  Parameters<typeof open>[0],
  "path" | "encoding" | "keyEncoding"
>

export class LMDBStorageAdapter implements StorageAdapterInterface {
  #db: RootDatabase<Uint8Array, StorageKey>
  /** Whether this adapter opened the database (and therefore closes it). */
  #ownsDb: boolean

  /**
   * @param pathOrDb - A path for the LMDB environment (created if absent),
   *   or an already-open lmdb-js database. lmdb-js treats an extensionless
   *   path as a directory (containing `data.mdb` + `lock.mdb`) and a path
   *   with a file extension (e.g. `db.lmdb`) as a single-file database. A
   *   supplied database must use the default `ordered-binary` key encoding
   *   and `binary` value encoding, and is not closed by {@link close}.
   * @param options - Forwarded to lmdb-js `open` when a path is given.
   */
  constructor(
    pathOrDb: string | RootDatabase<Uint8Array, StorageKey>,
    options: LMDBStorageAdapterOptions = {}
  ) {
    if (typeof pathOrDb === "string") {
      this.#db = open<Uint8Array, StorageKey>({
        path: pathOrDb,
        encoding: "binary",
        ...options,
      })
      this.#ownsDb = true
    } else {
      this.#db = pathOrDb
      this.#ownsDb = false
    }
  }

  async load(key: StorageKey): Promise<Uint8Array | undefined> {
    const value = this.#db.get(key)
    if (value === undefined) return undefined
    // Normalize Buffer to a plain Uint8Array copy: lmdb-js may hand back
    // views over reused buffers, and callers hold onto chunks.
    return new Uint8Array(value)
  }

  async save(key: StorageKey, data: Uint8Array): Promise<void> {
    // Copy before handing off: `put` commits asynchronously (batched into
    // the next write transaction) and the caller may reuse its buffer.
    await this.#db.put(key, new Uint8Array(data))
  }

  async remove(key: StorageKey): Promise<void> {
    await this.#db.remove(key)
  }

  async loadRange(keyPrefix: StorageKey): Promise<Chunk[]> {
    const chunks: Chunk[] = []
    // Component-wise ordering puts the prefix key itself first, followed by
    // every descendant; the scan ends at the first non-descendant.
    for (const { key, value } of this.#db.getRange({ start: keyPrefix })) {
      if (!startsWith(key, keyPrefix)) break
      chunks.push({ key: [...key], data: new Uint8Array(value) })
    }
    return chunks
  }

  async removeRange(keyPrefix: StorageKey): Promise<void> {
    const keys: StorageKey[] = []
    for (const key of this.#db.getKeys({ start: keyPrefix })) {
      if (!startsWith(key, keyPrefix)) break
      keys.push(key)
    }
    if (keys.length === 0) return
    this.#db.transactionSync(() => {
      for (const key of keys) this.#db.removeSync(key)
    })
  }

  async saveBatch(entries: Array<[StorageKey, Uint8Array]>): Promise<void> {
    // One LMDB transaction: either every entry becomes observable or none
    // does. The synchronous form is deliberate: an exception aborts a
    // `transactionSync` (verified by test), whereas writes inside the
    // async `transaction()` are NOT rolled back when the callback throws.
    // The cost is that the commit's fsync blocks the event loop for the
    // batch; plain `save()` keeps using the non-blocking async path.
    this.#db.transactionSync(() => {
      for (const [key, data] of entries) {
        this.#db.putSync(key, new Uint8Array(data))
      }
    })
  }

  async close(): Promise<void> {
    if (this.#ownsDb) await this.#db.close()
  }
}

const startsWith = (key: StorageKey, prefix: StorageKey): boolean => {
  if (key.length < prefix.length) return false
  for (let i = 0; i < prefix.length; i++) {
    if (key[i] !== prefix[i]) return false
  }
  return true
}
