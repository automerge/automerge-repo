import type { SubductionStorageAdapterInterface } from "@automerge/automerge-repo-subduction"

/** Browser storage adapter. Use one live Subduction backend per database. */
export class IndexedDBSubductionStorageAdapter implements SubductionStorageAdapterInterface {
  private db?: Promise<IDBDatabase>

  constructor(
    private readonly options: { database?: string; store?: string } = {}
  ) {}

  private get storeName(): string {
    return this.options.store ?? "bytes"
  }

  private open(): Promise<IDBDatabase> {
    if (this.db) return this.db
    const name = this.options.database ?? "automerge-repo-subduction"
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name)
      request.onupgradeneeded = () =>
        request.result.createObjectStore(this.storeName)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        if (this.db !== opening) {
          db.close()
          resolve(db)
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
    })
    this.db = opening
    void opening.catch(() => {
      if (this.db === opening) this.db = undefined
    })
    return opening
  }

  private async run<T>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => () => T
  ): Promise<T> {
    const db = await this.open()
    const transaction = db.transaction(this.storeName, mode)
    return new Promise<T>((resolve, reject) => {
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("IndexedDB transaction failed"))
      try {
        const result = operation(transaction.objectStore(this.storeName))
        // Request success alone is not a committed write.
        transaction.oncomplete = () => {
          try {
            resolve(result())
          } catch (error) {
            reject(error)
          }
        }
      } catch (error) {
        transaction.abort()
        reject(error)
      }
    })
  }

  loadMany(keys: readonly string[]): Promise<(Uint8Array | undefined)[]> {
    if (!keys.length) return Promise.resolve([])
    const owned = [...keys]
    return this.run("readonly", store => {
      const requests = owned.map(key => store.get(key))
      return () =>
        requests.map(request => request.result as Uint8Array | undefined)
    })
  }

  /** One readwrite transaction: IndexedDB commits every put or none. */
  saveBatch(entries: readonly [string, Uint8Array][]): Promise<void> {
    const copies = entries.map(
      ([key, bytes]) => [key, new Uint8Array(bytes)] as const
    )
    if (!copies.length) return Promise.resolve()
    return this.run("readwrite", store => {
      for (const [key, bytes] of copies) store.put(bytes, key)
      return () => {}
    })
  }

  /** One readwrite transaction: IndexedDB commits every delete or none. */
  removeBatch(keys: readonly string[]): Promise<void> {
    const owned = [...keys]
    if (!owned.length) return Promise.resolve()
    return this.run("readwrite", store => {
      for (const key of owned) store.delete(key)
      return () => {}
    })
  }

  removeRange(prefix: string): Promise<void> {
    return this.run("readwrite", store => {
      store.delete(IDBKeyRange.bound(prefix, prefix + "\uffff"))
      return () => {}
    })
  }

  list(prefix: string): Promise<string[]> {
    return this.run("readonly", store => {
      const request = store.getAllKeys(
        IDBKeyRange.bound(prefix, prefix + "\uffff")
      )
      return () => request.result as string[]
    })
  }

  loadPrefix(prefix: string): Promise<[string, Uint8Array][]> {
    return this.run("readonly", store => {
      const range = IDBKeyRange.bound(prefix, prefix + "\uffff")
      const values = store.getAll(range)
      const keys = store.getAllKeys(range)
      return () =>
        (keys.result as string[]).map(
          (key, index) => [key, values.result[index]] as [string, Uint8Array]
        )
    })
  }

  /** Close the connection after any pending database open; later calls reopen it. */
  async close(): Promise<void> {
    const opening = this.db
    this.db = undefined
    if (opening) (await opening).close()
  }
}
