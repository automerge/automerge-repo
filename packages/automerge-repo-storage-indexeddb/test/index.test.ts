import { describe, it, expect, beforeEach } from "vitest"
import { IndexedDBStorageAdapter } from "../src/index.js"

// The adapter creates its transaction and request inside each method, so the
// error channel is driven through a fake db whose transaction / request we
// control. dbPromise is overwritten after construction.
function fakeDb() {
  const request: any = {}
  const transaction: any = {
    objectStore: () => ({
      get: () => request,
      openCursor: () => request,
      put: () => request,
      delete: () => request,
    }),
  }
  return { db: { transaction: () => transaction } as any, transaction, request }
}

// Let the method await its (already resolved) dbPromise and wire up handlers.
const settled = () => new Promise(resolve => setTimeout(resolve, 0))

describe("IndexedDBStorageAdapter error channel", () => {
  beforeEach(() => {
    // The constructor opens IndexedDB; stub it when the env has none. Each test
    // overwrites dbPromise with a controllable fake right after constructing.
    if (typeof globalThis.indexedDB === "undefined") {
      globalThis.indexedDB = { open: () => ({}) } as unknown as IDBFactory
    }
  })

  it("rejects load with the transaction error when the request error is null", async () => {
    const adapter = new IndexedDBStorageAdapter()
    const { db, transaction, request } = fakeDb()
    ;(adapter as any).dbPromise = Promise.resolve(db)

    const loaded = adapter.load(["doc", "key"])
    await settled()

    // A transaction-level failure (e.g. quota) sets transaction.error while the
    // request error stays null.
    const quota = new DOMException("quota exceeded", "QuotaExceededError")
    transaction.error = quota
    request.error = null
    transaction.onerror(new Event("error"))

    await expect(loaded).rejects.toBe(quota)
  })

  it("rejects load when the transaction aborts instead of hanging", async () => {
    const adapter = new IndexedDBStorageAdapter()
    const { db, transaction } = fakeDb()
    ;(adapter as any).dbPromise = Promise.resolve(db)

    const loaded = adapter.load(["doc", "key"])
    await settled()

    expect(typeof transaction.onabort).toBe("function")
    const aborted = new DOMException("aborted", "AbortError")
    transaction.error = aborted
    transaction.onabort(new Event("abort"))

    await expect(loaded).rejects.toBe(aborted)
  })

  it("rejects save when the transaction aborts instead of hanging", async () => {
    const adapter = new IndexedDBStorageAdapter()
    const { db, transaction } = fakeDb()
    ;(adapter as any).dbPromise = Promise.resolve(db)

    const saved = adapter.save(["doc", "key"], new Uint8Array([1, 2, 3]))
    await settled()

    expect(typeof transaction.onabort).toBe("function")
    const aborted = new DOMException("aborted", "AbortError")
    transaction.error = aborted
    transaction.onabort(new Event("abort"))

    await expect(saved).rejects.toBe(aborted)
  })
})
