import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  IndexedDBSubductionStorageAdapter,
  type SubductionStorageAdapterInterface,
} from "../src/index.js"
import { DummySubductionStorageAdapter } from "../src/helpers/DummySubductionStorageAdapter.js"

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory())
  vi.stubGlobal("IDBKeyRange", IDBKeyRange)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

for (const [name, create] of [
  ["memory", () => new DummySubductionStorageAdapter()],
  [
    "indexeddb",
    () => new IndexedDBSubductionStorageAdapter({ database: "contract" }),
  ],
] as const) {
  describe(`${name} storage adapter`, () => {
    let store: SubductionStorageAdapterInterface
    beforeEach(() => {
      store = create()
    })
    afterEach(async () => {
      if (store instanceof IndexedDBSubductionStorageAdapter)
        await store.close()
    })

    it("saves, replaces, loads, and removes single values", async () => {
      expect(await store.loadMany(["missing"])).toEqual([undefined])
      await store.saveBatch([["key", new Uint8Array([1, 2])]])
      expect(await store.loadMany(["key"])).toEqual([new Uint8Array([1, 2])])
      await store.saveBatch([["key", new Uint8Array([3])]])
      expect(await store.loadMany(["key"])).toEqual([new Uint8Array([3])])
      await store.removeBatch(["key"])
      expect(await store.loadMany(["key"])).toEqual([undefined])
    })

    it("lists and loads keys by exact prefix in sorted order", async () => {
      await store.saveBatch([
        ["a/z", new Uint8Array([1])],
        ["a", new Uint8Array([2])],
        ["a0", new Uint8Array([3])],
        ["a/b", new Uint8Array([4])],
        ["b/x", new Uint8Array([5])],
      ])
      expect(await store.list("a/")).toEqual(["a/b", "a/z"])
      expect(await store.loadPrefix("a/")).toEqual([
        ["a/b", new Uint8Array([4])],
        ["a/z", new Uint8Array([1])],
      ])
      expect(await store.list("missing")).toEqual([])
      expect(await store.loadPrefix("")).toHaveLength(5)
    })

    it("loads requested keys in order from one consistent cut", async () => {
      await store.saveBatch([
        ["pair/signed", new Uint8Array([1])],
        ["pair/blob", new Uint8Array([2])],
      ])
      const reading = store.loadMany(["pair/signed", "missing", "pair/blob"])
      const replacing = store.saveBatch([
        ["pair/signed", new Uint8Array([3])],
        ["pair/blob", new Uint8Array([4])],
      ])
      const seen = await reading
      await replacing
      expect([
        [1, undefined, 2],
        [3, undefined, 4],
      ]).toContainEqual(seen.map(value => value?.[0]))
      expect(await store.loadMany([])).toEqual([])
    })

    it("saves a batch as one visible cut", async () => {
      await store.saveBatch([["b/1", new Uint8Array([0])]])
      const saving = store.saveBatch([
        ["b/1", new Uint8Array([1])],
        ["b/2", new Uint8Array([2])],
      ])
      const reading = store.loadPrefix("b/")
      const seen = await reading
      await saving
      expect([
        [["b/1", new Uint8Array([0])]],
        [
          ["b/1", new Uint8Array([1])],
          ["b/2", new Uint8Array([2])],
        ],
      ]).toContainEqual(seen)
      expect(await store.list("b/")).toEqual(["b/1", "b/2"])
    })

    it("removes a batch together", async () => {
      await store.saveBatch([
        ["r/1", new Uint8Array([1])],
        ["r/2", new Uint8Array([2])],
        ["r/3", new Uint8Array([3])],
      ])
      const removing = store.removeBatch(["r/1", "r/3"])
      const reading = store.list("r/")
      expect([["r/1", "r/2", "r/3"], ["r/2"]]).toContainEqual(await reading)
      await removing
      expect(await store.list("r/")).toEqual(["r/2"])
    })

    it("removes every key under a prefix", async () => {
      await store.saveBatch([
        ["r", new Uint8Array([1])],
        ["r/1", new Uint8Array([2])],
        ["r/nested/2", new Uint8Array([3])],
        ["r0", new Uint8Array([4])],
      ])
      await store.removeRange("r/")
      expect(await store.list("")).toEqual(["r", "r0"])
      await store.removeRange("")
      expect(await store.list("")).toEqual([])
    })

    it("owns stored bytes and returns caller-owned bytes", async () => {
      const input = new Uint8Array([1])
      const saving = store.saveBatch([["p/key", input]])
      input[0] = 2
      await saving
      const [[, loaded]] = await store.loadPrefix("p/")
      expect(loaded).toEqual(new Uint8Array([1]))
      loaded[0] = 3
      expect(await store.loadMany(["p/key"])).toEqual([new Uint8Array([1])])
    })
  })
}

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
