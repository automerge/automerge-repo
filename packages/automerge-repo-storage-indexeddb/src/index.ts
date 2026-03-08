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

  // Write batching: collect saves/removes and flush in a single readwrite
  // transaction per microtask. IndexedDB serializes readwrite transactions,
  // so batching N writes into 1 transaction eliminates (N-1) lock waits.
  private pendingWrites: {
    type: "save"
    key: string[]
    binary: Uint8Array
    resolve: () => void
    reject: (err: unknown) => void
  }[] = []

  private pendingDeletes: {
    type: "remove"
    key: string[]
    resolve: () => void
    reject: (err: unknown) => void
  }[] = []

  private flushScheduled = false

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

  private scheduleFlush(): void {
    if (this.flushScheduled) return
    this.flushScheduled = true
    // Use setTimeout instead of queueMicrotask to avoid microtask starvation.
    // Each flush() resolves write promises whose continuations may trigger more
    // saves (e.g. commit-saved → handle.update → sync → saveCommit). With
    // queueMicrotask these would chain indefinitely in the microtask queue,
    // starving macrotasks like MessageChannel.onmessage and IDB callbacks.
    setTimeout(() => this.flush(), 0)
  }

  private async flush(): Promise<void> {
    this.flushScheduled = false

    const writes = this.pendingWrites.splice(0)
    const deletes = this.pendingDeletes.splice(0)
    if (writes.length === 0 && deletes.length === 0) return

    try {
      const db = await this.dbPromise
      const transaction = db.transaction(this.store, "readwrite")
      const objectStore = transaction.objectStore(this.store)

      for (const op of writes) {
        objectStore.put({ key: op.key, binary: op.binary }, op.key)
      }

      for (const op of deletes) {
        objectStore.delete(op.key)
      }

      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () =>
          reject(transaction.error ?? new DOMException("Transaction aborted"))
      })

      for (const op of writes) op.resolve()
      for (const op of deletes) op.resolve()
    } catch (err) {
      for (const op of writes) op.reject(err)
      for (const op of deletes) op.reject(err)
    }
  }

  async load(keyArray: string[]): Promise<Uint8Array | undefined> {
    // Check pending deletes first (delete wins over prior write)
    for (const op of this.pendingDeletes) {
      if (arraysEqual(op.key, keyArray)) return undefined
    }

    // Check pending writes (return queued but unflushed data)
    for (let i = this.pendingWrites.length - 1; i >= 0; i--) {
      const op = this.pendingWrites[i]
      if (arraysEqual(op.key, keyArray)) return op.binary
    }

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
    return new Promise((resolve, reject) => {
      this.pendingWrites.push({
        type: "save",
        key: keyArray,
        binary,
        resolve,
        reject,
      })
      this.scheduleFlush()
    })
  }

  async remove(keyArray: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      this.pendingDeletes.push({
        type: "remove",
        key: keyArray,
        resolve,
        reject,
      })
      this.scheduleFlush()
    })
  }

  async loadRange(keyPrefix: string[]): Promise<Chunk[]> {
    // Snapshot pending state BEFORE any awaits to avoid races with flush().
    // A flush could splice items out of the pending queues during IDB reads,
    // but those items would also not yet be visible to our readonly transaction.
    const deletedKeys = new Set<string>()
    for (const op of this.pendingDeletes) {
      if (isPrefix(keyPrefix, op.key)) {
        deletedKeys.add(op.key.join("\x00"))
      }
    }

    const pendingByKey = new Map<
      string,
      { binary: Uint8Array; key: string[] }
    >()
    for (const op of this.pendingWrites) {
      if (isPrefix(keyPrefix, op.key)) {
        pendingByKey.set(op.key.join("\x00"), {
          binary: op.binary,
          key: op.key,
        })
      }
    }

    const db = await this.dbPromise
    const lowerBound = keyPrefix
    const upperBound = [...keyPrefix, "\uffff"]
    const range = IDBKeyRange.bound(lowerBound, upperBound)

    const transaction = db.transaction(this.store)
    const objectStore = transaction.objectStore(this.store)
    const request = objectStore.openCursor(range)
    const cursorResults: Chunk[] = []

    const idbResult = await new Promise<Chunk[]>((resolve, reject) => {
      transaction.onerror = () => {
        reject(request.error)
      }

      request.onsuccess = event => {
        const cursor = (event.target as IDBRequest).result as IDBCursorWithValue
        if (cursor) {
          cursorResults.push({
            data: (cursor.value as { binary: Uint8Array }).binary,
            key: cursor.key as StorageKey,
          })
          cursor.continue()
        } else {
          resolve(cursorResults)
        }
      }
    })

    // Merge IDB results with snapshotted pending state.
    const merged = new Map<string, Chunk>()
    for (const chunk of idbResult) {
      const keyStr = (chunk.key as string[]).join("\x00")
      if (deletedKeys.has(keyStr)) continue
      if (pendingByKey.has(keyStr)) {
        const pending = pendingByKey.get(keyStr)!
        merged.set(keyStr, { data: pending.binary, key: chunk.key })
        pendingByKey.delete(keyStr)
      } else {
        merged.set(keyStr, chunk)
      }
    }

    // Add pending writes not found in IDB
    for (const [keyStr, { binary, key }] of pendingByKey) {
      merged.set(keyStr, {
        data: binary,
        key: key as StorageKey,
      })
    }

    return Array.from(merged.values())
  }

  async removeRange(keyPrefix: string[]): Promise<void> {
    // Evict pending writes that fall within the range so subsequent reads
    // don't return data that's about to be deleted.
    for (let i = this.pendingWrites.length - 1; i >= 0; i--) {
      if (isPrefix(keyPrefix, this.pendingWrites[i].key)) {
        const [removed] = this.pendingWrites.splice(i, 1)
        removed.resolve()
      }
    }

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

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function isPrefix(prefix: string[], key: string[]): boolean {
  if (key.length < prefix.length) return false
  for (let i = 0; i < prefix.length; i++) {
    if (key[i] !== prefix[i]) return false
  }
  return true
}
