import { StorageAdapter } from "@automerge/automerge-repo"

export class IndexedDBStorageAdapter extends StorageAdapter {
  private dbPromise: Promise<IDBDatabase>

  constructor() {
    super()
    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open("automerge", 1)

      request.onerror = function () {
        reject("Database error: " + request.error)
      }

      request.onupgradeneeded = function (event: IDBVersionChangeEvent) {
        const db = (event.target as IDBOpenDBRequest).result
        db.createObjectStore("documents") // No keyPath specified here.
      }

      request.onsuccess = function (event) {
        const db = (event.target as IDBOpenDBRequest).result as IDBDatabase
        resolve(db)
      }
    })
  }

  async load(keyArray: string[]): Promise<Uint8Array | undefined> {
    const db = await this.dbPromise

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(["documents"])
      const objectStore = transaction.objectStore("documents")
      const request = objectStore.get(keyArray)

      request.onerror = function () {
        reject("Unable to retrieve data from database!")
      }

      request.onsuccess = function (event) {
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
      const transaction = db.transaction(["documents"], "readwrite")
      const objectStore = transaction.objectStore("documents")
      const request = objectStore.put(
        { key: keyArray, binary: binary },
        keyArray
      )

      request.onerror = function () {
        reject("Unable to save data to database!")
      }

      request.onsuccess = function () {
        resolve()
      }
    })
  }

  async remove(keyArray: string[]): Promise<void> {
    const db = await this.dbPromise
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(["documents"], "readwrite")
      const objectStore = transaction.objectStore("documents")
      const request = objectStore.delete(keyArray)

      request.onerror = function () {
        reject("Unable to delete data from database!")
      }

      request.onsuccess = function () {
        resolve()
      }
    })
  }

  async loadPrefix(keyPrefix: string[]): Promise<Uint8Array> {
    const db = await this.dbPromise
    const lowerBound = keyPrefix
    const upperBound = [...keyPrefix, "\uffff"]
    const range = IDBKeyRange.bound(lowerBound, upperBound)

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(["documents"])
      const objectStore = transaction.objectStore("documents")
      const request = objectStore.openCursor(range)
      const arrays: Uint8Array[] = []

      request.onerror = function () {
        reject("Unable to retrieve data from database!")
      }

      request.onsuccess = function (event) {
        const cursor = (event.target as IDBRequest).result as IDBCursorWithValue
        if (cursor) {
          arrays.push((cursor.value as { binary: Uint8Array }).binary)
          cursor.continue()
        } else {
          let totalLength = arrays.reduce((acc, val) => acc + val.length, 0)
          let result = new Uint8Array(totalLength)
          let offset = 0
          for (let array of arrays) {
            result.set(array, offset)
            offset += array.length
          }
          resolve(result)
        }
      }
    })
  }
}
