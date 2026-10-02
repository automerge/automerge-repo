import type { LocalByteStore } from "./storage.js"

/** Browser byte store. Use one live Subduction backend per database. */
export class IndexedDBByteStore implements LocalByteStore {
  private db?: Promise<IDBDatabase>

  constructor(
    private readonly options: {
      database?: string
      store?: string
    } = {}
  ) {}

  private open(): Promise<IDBDatabase> {
    if (this.db) return this.db
    const name = this.options.database ?? "automerge-repo-subduction"
    const store = this.options.store ?? "bytes"
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      let abandoned = false
      const openVersion = (version?: number) => {
        const request =
          version === undefined
            ? indexedDB.open(name)
            : indexedDB.open(name, version)
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(store))
            request.result.createObjectStore(store)
        }
        request.onerror = () => reject(request.error)
        request.onblocked = () => {
          abandoned = true
          reject(new Error(`IndexedDB open blocked: ${name}`))
        }
        request.onsuccess = () => {
          const db = request.result
          if (abandoned || this.db !== opening) {
            db.close()
            resolve(db)
          } else if (!db.objectStoreNames.contains(store)) {
            const nextVersion = db.version + 1
            db.close()
            openVersion(nextVersion)
          } else {
            const schema = db.transaction(store, "readonly").objectStore(store)
            if (schema.keyPath !== null || schema.autoIncrement) {
              db.close()
              reject(
                new TypeError(
                  `Invalid IndexedDB object store ${name}/${store}: expected out-of-line keys without autoIncrement`
                )
              )
              return
            }
            const invalidate = () => {
              if (this.db === opening) this.db = undefined
            }
            db.onclose = invalidate
            db.onversionchange = () => {
              db.close()
              invalidate()
            }
            resolve(db)
          }
        }
      }
      openVersion()
    })
    this.db = opening
    void opening.catch(() => {
      if (this.db === opening) this.db = undefined
    })
    return opening
  }

  private async run<T>(
    mode: IDBTransactionMode,
    operation: (
      store: IDBObjectStore,
      result: (value: T) => void,
      fail: (cause: unknown) => void
    ) => IDBRequest
  ): Promise<T> {
    const db = await this.open()
    const transaction = db.transaction(this.options.store ?? "bytes", mode)
    return new Promise<T>((resolve, reject) => {
      let result: T
      let failure: unknown
      const request = operation(
        transaction.objectStore(this.options.store ?? "bytes"),
        value => {
          result = value
        },
        cause => {
          failure = cause
          transaction.abort()
        }
      )
      transaction.onabort = () =>
        reject(
          failure ??
            transaction.error ??
            request.error ??
            new Error("IndexedDB transaction failed")
        )
      transaction.oncomplete = () => resolve(result)
    })
  }

  load(key: string): Promise<Uint8Array | undefined> {
    return this.run("readonly", (store, done, fail) => {
      const request = store.get(key)
      request.onsuccess = () => {
        const value: unknown = request.result
        if (value !== undefined && !(value instanceof Uint8Array)) {
          fail(new TypeError(`Invalid IndexedDB byte value for ${key}`))
          return
        }
        done(value as Uint8Array | undefined)
      }
      return request
    })
  }

  save(key: string, bytes: Uint8Array): Promise<void> {
    // Snapshot synchronously, before waiting for the database to open.
    const copy = new Uint8Array(bytes)
    return this.run("readwrite", store => store.put(copy, key))
  }

  remove(key: string): Promise<void> {
    return this.run("readwrite", store => store.delete(key))
  }

  list(prefix: string): Promise<string[]> {
    return this.run("readonly", (store, done) => {
      const keys: string[] = []
      const request = store.openKeyCursor(IDBKeyRange.lowerBound(prefix))
      request.onsuccess = () => {
        const cursor = request.result
        if (
          cursor &&
          typeof cursor.key === "string" &&
          cursor.key.startsWith(prefix)
        ) {
          keys.push(cursor.key)
          cursor.continue()
        } else done(keys)
      }
      return request
    })
  }

  /** Close the connection after any pending database open; later calls reopen it. */
  async close(): Promise<void> {
    const opening = this.db
    this.db = undefined
    if (opening) (await opening).close()
  }
}
