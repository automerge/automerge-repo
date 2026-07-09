/**
 * This module provides a storage adapter for IndexedDB.
 *
 * @packageDocumentation
 */

import {
  Chunk,
  StorageAdapterInterface,
  type StorageKey,
} from "@automerge/automerge-repo/slim"

/**
 * Reject on any failure of `transaction` or its `request`, so the caller's
 * promise always settles.
 *
 * A failure can surface through more than one event, so all are wired:
 *   - `request.onerror` fires for a request-level failure (e.g. a constraint
 *     violation).
 *   - `transaction.onerror` / `transaction.onabort` fire for a transaction-level
 *     failure (quota exhaustion, an I/O error, an explicit abort). They also
 *     fire when an unhandled request error bubbles up and aborts the
 *     transaction.
 *
 * The reason prefers `transaction.error` because, per the IndexedDB spec, it is
 * either a reference to the same error the failing request raised (so nothing
 * is lost) or the transaction-level reason such as `QuotaExceededError`, for
 * which `request.error` is null. `request.error` is the fallback for the moment
 * a request fails before the abort has set `transaction.error`. If both are
 * null (an explicit `abort()`), a generic error is used.
 *
 * Exported only so it can be unit-tested directly; `@internal` keeps it out of
 * the package's published types.
 * @internal
 */
export function rejectOnFailure(
  transaction: IDBTransaction,
  request: IDBRequest,
  reject: (reason: unknown) => void
): void {
  const fail = () =>
    reject(
      transaction.error ??
        request.error ??
        new Error("IndexedDB transaction failed")
    )
  // A request error bubbles to the transaction, so `fail` may run more than
  // once; that is harmless because `reject` is a no-op once the promise has
  // settled.
  request.onerror = fail
  transaction.onerror = fail
  transaction.onabort = fail
}

export class IndexedDBStorageAdapter implements StorageAdapterInterface {
  private dbPromise: Promise<IDBDatabase>

  /** Create a new {@link IndexedDBStorageAdapter}.
   * @param database - The name of the database to use. Defaults to "automerge".
   * @param store - The name of the object store to use. Defaults to "documents".
   */
  constructor(
    private database: string = "automerge",
    private store: string = "documents"
  ) {
    this.dbPromise = this.createDatabasePromise()
  }

  private createDatabasePromise(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.database, 1)

      request.onerror = () => {
        reject(request.error)
      }

      request.onupgradeneeded = event => {
        const db = (event.target as IDBOpenDBRequest).result
        db.createObjectStore(this.store)
      }

      request.onsuccess = event => {
        const db = (event.target as IDBOpenDBRequest).result as IDBDatabase
        resolve(db)
      }
    })
  }

  async load(keyArray: string[]): Promise<Uint8Array | undefined> {
    const db = await this.dbPromise

    const transaction = db.transaction(this.store)
    const objectStore = transaction.objectStore(this.store)
    const request = objectStore.get(keyArray)

    return new Promise((resolve, reject) => {
      rejectOnFailure(transaction, request, reject)

      request.onsuccess = event => {
        const result = (event.target as IDBRequest).result
        if (result && typeof result === "object" && "binary" in result) {
          resolve((result as { binary: Uint8Array }).binary)
        } else {
          resolve(undefined)
        }
      }
    })
  }

  async save(keyArray: string[], binary: Uint8Array): Promise<void> {
    const db = await this.dbPromise

    const transaction = db.transaction(this.store, "readwrite")
    const objectStore = transaction.objectStore(this.store)
    const request = objectStore.put({ key: keyArray, binary: binary }, keyArray)

    return new Promise((resolve, reject) => {
      rejectOnFailure(transaction, request, reject)
      transaction.oncomplete = () => {
        resolve()
      }
    })
  }

  async remove(keyArray: string[]): Promise<void> {
    const db = await this.dbPromise

    const transaction = db.transaction(this.store, "readwrite")
    const objectStore = transaction.objectStore(this.store)
    const request = objectStore.delete(keyArray)

    return new Promise((resolve, reject) => {
      rejectOnFailure(transaction, request, reject)
      transaction.oncomplete = () => {
        resolve()
      }
    })
  }

  async loadRange(keyPrefix: string[]): Promise<Chunk[]> {
    const db = await this.dbPromise
    const lowerBound = keyPrefix
    const upperBound = [...keyPrefix, "\uffff"]
    const range = IDBKeyRange.bound(lowerBound, upperBound)

    const transaction = db.transaction(this.store)
    const objectStore = transaction.objectStore(this.store)
    const request = objectStore.openCursor(range)
    const result: { data: Uint8Array; key: StorageKey }[] = []

    return new Promise((resolve, reject) => {
      rejectOnFailure(transaction, request, reject)

      request.onsuccess = event => {
        const cursor = (event.target as IDBRequest).result as IDBCursorWithValue
        if (cursor) {
          result.push({
            data: (cursor.value as { binary: Uint8Array }).binary,
            key: cursor.key as StorageKey,
          })
          cursor.continue()
        } else {
          resolve(result)
        }
      }
    })
  }

  async removeRange(keyPrefix: string[]): Promise<void> {
    const db = await this.dbPromise
    const lowerBound = keyPrefix
    const upperBound = [...keyPrefix, "\uffff"]
    const range = IDBKeyRange.bound(lowerBound, upperBound)

    const transaction = db.transaction(this.store, "readwrite")
    const objectStore = transaction.objectStore(this.store)
    const request = objectStore.delete(range)

    return new Promise((resolve, reject) => {
      rejectOnFailure(transaction, request, reject)
      transaction.oncomplete = () => {
        resolve()
      }
    })
  }

  /** Close the underlying database connection. */
  async close(): Promise<void> {
    const db = await this.dbPromise
    db.close()
  }
}
