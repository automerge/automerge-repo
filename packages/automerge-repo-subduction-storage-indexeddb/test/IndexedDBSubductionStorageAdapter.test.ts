import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runSubductionStorageAdapterTests } from "@automerge/automerge-repo-subduction/helpers/tests/subduction-storage-adapter-tests.js"
import { IndexedDBSubductionStorageAdapter } from "../src/index.js"

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory())
  vi.stubGlobal("IDBKeyRange", IDBKeyRange)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

runSubductionStorageAdapterTests(async () => {
  const adapter = new IndexedDBSubductionStorageAdapter({
    database: "contract",
  })
  return { adapter, teardown: () => adapter.close() }
}, "IndexedDBSubductionStorageAdapter")

describe("IndexedDBSubductionStorageAdapter", () => {
  it("persists in the default database across close and reopen", async () => {
    const store = new IndexedDBSubductionStorageAdapter()
    try {
      await store.saveBatch([["key", new Uint8Array([1])]])
      await store.close()
      expect(await store.loadMany(["key"])).toEqual([new Uint8Array([1])])
      expect(await indexedDB.databases()).toContainEqual(
        expect.objectContaining({ name: "automerge-repo-subduction" })
      )
    } finally {
      await store.close()
    }
  })

  it("uses a configured database and object store", async () => {
    const options = { database: "custom", store: "documents" }
    const store = new IndexedDBSubductionStorageAdapter(options)
    try {
      await store.saveBatch([["key", new Uint8Array([7])]])
      await store.close()
      const reopened = new IndexedDBSubductionStorageAdapter(options)
      try {
        expect(await reopened.loadMany(["key"])).toEqual([new Uint8Array([7])])
      } finally {
        await reopened.close()
      }
    } finally {
      await store.close()
    }
  })

  it("does not resolve a batch that aborts after a successful put", async () => {
    const open = vi.spyOn(indexedDB, "open")
    const store = new IndexedDBSubductionStorageAdapter({ database: "aborted" })
    try {
      await store.saveBatch([["a", new Uint8Array([1])]])
      const db = open.mock.results[0].value.result as IDBDatabase
      const transaction = db.transaction.bind(db)
      vi.spyOn(db, "transaction").mockImplementationOnce((...args) => {
        const tx = transaction(...args)
        const objectStore = tx.objectStore("bytes")
        const put = objectStore.put.bind(objectStore)
        vi.spyOn(tx, "objectStore").mockReturnValue(objectStore)
        vi.spyOn(objectStore, "put").mockImplementation((...args) => {
          const request = put(...args)
          request.addEventListener("success", () => tx.abort(), { once: true })
          return request
        })
        return tx
      })
      await expect(
        store.saveBatch([
          ["a", new Uint8Array([2])],
          ["b", new Uint8Array([3])],
        ])
      ).rejects.toThrow()
      expect(await store.loadPrefix("")).toEqual([["a", new Uint8Array([1])]])
    } finally {
      await store.close()
    }
  })
})
