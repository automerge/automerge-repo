import { describe, it, expect, beforeEach } from "vitest"
import { IndexedDBStorageAdapter } from "../src/index.js"

describe("IndexedDBStorageAdapter close", () => {
  beforeEach(() => {
    // The constructor opens IndexedDB; stub it when the env has none.
    if (typeof globalThis.indexedDB === "undefined") {
      globalThis.indexedDB = { open: () => ({}) } as unknown as IDBFactory
    }
  })

  it("closes the underlying database connection", async () => {
    const adapter = new IndexedDBStorageAdapter()
    let closed = 0
    ;(adapter as any).dbPromise = Promise.resolve({
      close: () => {
        closed++
      },
    })

    await adapter.close()
    expect(closed).toBe(1)
  })
})
