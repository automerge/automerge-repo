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
      transaction.onerror = () => {
        reject(request.error)
      }

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
    objectStore.put({ key: keyArray, binary: binary }, keyArray)

    return new Promise((resolve, reject) => {
      transaction.onerror = () => {
        reject(transaction.error)
      }
      transaction.oncomplete = () => {
        resolve()
      }
    })
  }

  async remove(keyArray: string[]): Promise<void> {
    const db = await this.dbPromise

    const transaction = db.transaction(this.store, "readwrite")
    const objectStore = transaction.objectStore(this.store)
    objectStore.delete(keyArray)

    return new Promise((resolve, reject) => {
      transaction.onerror = () => {
        reject(transaction.error)
      }
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
      transaction.onerror = () => {
        reject(request.error)
      }

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
    objectStore.delete(range)

    return new Promise((resolve, reject) => {
      transaction.onerror = () => {
        reject(transaction.error)
      }
      transaction.oncomplete = () => {
        resolve()
      }
    })
  }
}
