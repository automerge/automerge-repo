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

  async saveBatch(entries: Array<[string[], Uint8Array]>): Promise<void> {
    if (entries.length === 0) return
    const db = await this.dbPromise

    const transaction = db.transaction(this.store, "readwrite")
    const objectStore = transaction.objectStore(this.store)
    for (const [keyArray, binary] of entries) {
      objectStore.put({ key: keyArray, binary }, keyArray)
    }

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

    // Use getAll + getAllKeys instead of a cursor to avoid per-row
    // event loop yields. Returns all matching results in a single callback.
    const valRequest = objectStore.getAll(range)
    const keyRequest = objectStore.getAllKeys(range)

    return new Promise((resolve, reject) => {
      transaction.onerror = () => {
        reject(transaction.error)
      }

      let values: any[] | undefined
      let keys: IDBValidKey[] | undefined

      const tryResolve = () => {
        if (!values || !keys) return
        const result: Chunk[] = new Array(values.length)
        for (let i = 0; i < values.length; i++) {
          result[i] = {
            data: (values[i] as { binary: Uint8Array }).binary,
            key: keys[i] as StorageKey,
          }
        }
        resolve(result)
      }

      valRequest.onsuccess = () => {
        values = valRequest.result
        tryResolve()
      }
      keyRequest.onsuccess = () => {
        keys = keyRequest.result
        tryResolve()
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
