import { StorageAdapter } from "@automerge/automerge-repo"

export class IndexedDBStorageAdapter extends StorageAdapter {
  private dbPromise: Promise<IDBDatabase>
  database = "automerge"
  store = "documents"

  constructor() {
    super()
    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(this.database, 1)

      request.onerror = () => {
        reject(new Error("Database error: " + request.error))
      }

      request.onupgradeneeded = event => {
        const db = (event.target as IDBOpenDBRequest).result
        db.createObjectStore(this.store) // No keyPath specified here.
      }

      request.onsuccess = event => {
        const db = (event.target as IDBOpenDBRequest).result as IDBDatabase
        resolve(db)
      }
    })
  }

  async load(keyArray: string[]): Promise<Uint8Array | undefined> {
    const db = await this.dbPromise

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([this.store])
      const objectStore = transaction.objectStore(this.store)
      const request = objectStore.get(keyArray)

      request.onerror = () => {
        reject(new Error("Unable to retrieve data from database!"))
      }

      request.onsuccess = event => {
        resolve(
          ((event.target as IDBRequest).result as { binary: Uint8Array })
            ?.binary
        )
      }
    })
  }

  async save(keyArray: string[], binary: Uint8Array): Promise<void> {
    const db = await this.dbPromise
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([this.store], "readwrite")
      const objectStore = transaction.objectStore(this.store)
      const request = objectStore.put(
        { key: keyArray, binary: binary },
        keyArray
      )

      request.onerror = () => {
        reject(new Error("Unable to save data to database!"))
      }

      request.onsuccess = () => {
        resolve()
      }
    })
  }

  async remove(keyArray: string[]): Promise<void> {
    const db = await this.dbPromise
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([this.store], "readwrite")
      const objectStore = transaction.objectStore(this.store)
      const request = objectStore.delete(keyArray)

      request.onerror = () => {
        reject(new Error("Unable to delete data from database!"))
      }

      request.onsuccess = () => {
        resolve()
      }
    })
  }

  async loadRange(keyPrefix: string[]): Promise<Uint8Array[]> {
    const db = await this.dbPromise
    const lowerBound = keyPrefix
    const upperBound = [...keyPrefix, "\uffff"]
    const range = IDBKeyRange.bound(lowerBound, upperBound)

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([this.store])
      const objectStore = transaction.objectStore(this.store)
      const request = objectStore.openCursor(range)
      const arrays: Uint8Array[] = []

      request.onerror = () => {
        reject(new Error("Unable to retrieve data from database!"))
      }

      request.onsuccess = event => {
        const cursor = (event.target as IDBRequest).result as IDBCursorWithValue
        if (cursor) {
          console.log(cursor.value.key)
          arrays.push((cursor.value as { binary: Uint8Array }).binary)
          cursor.continue()
        } else {
          resolve(arrays)
        }
      }
    })
  }

  async removeRange(keyPrefix: string[]): Promise<void> {
    const db = await this.dbPromise
    const lowerBound = keyPrefix
    const upperBound = [...keyPrefix, "\uffff"]
    const range = IDBKeyRange.bound(lowerBound, upperBound)

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([this.store], "readwrite")
      const objectStore = transaction.objectStore(this.store)
      const request = objectStore.delete(range)

      request.onsuccess = (event: Event) => {
        resolve()
      }

      request.onerror = (event: Event) => {
        reject(new Error("Unable to remove data from database!"))
      }
    })
  }
}
