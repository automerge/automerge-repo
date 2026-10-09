import * as N from "@automerge/subduction"
import {
  commitId,
  sedimentreeId,
  type LooseCommitRecord,
} from "@automerge/automerge-repo/sedimentree"
import { IDBFactory, IDBKeyRange, forceCloseDatabase } from "fake-indexeddb"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  IndexedDBByteStore,
  MemoryByteStore,
  SubductionBackend,
  type LocalByteStore,
} from "../src/index.js"

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory())
  vi.stubGlobal("IDBKeyRange", IDBKeyRange)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

for (const [name, create] of [
  ["memory", () => new MemoryByteStore()],
  ["indexeddb", () => new IndexedDBByteStore({ database: "contract" })],
] as const) {
  describe(`${name} LocalByteStore`, () => {
    let store: LocalByteStore
    beforeEach(() => {
      store = create()
    })
    afterEach(async () => {
      if (store instanceof IndexedDBByteStore) await store.close()
    })

    it("roundtrips values, atomically replaces one key and removes idempotently", async () => {
      expect(await store.load("missing")).toBeUndefined()
      await store.save("key", new Uint8Array([1, 2]))
      expect(await store.load("key")).toEqual(new Uint8Array([1, 2]))
      await store.save("key", new Uint8Array([3]))
      expect(await store.load("key")).toEqual(new Uint8Array([3]))
      await store.remove("key")
      await store.remove("key")
      expect(await store.load("key")).toBeUndefined()
    })

    it("lists full keys by exact prefix in sorted order", async () => {
      for (const key of ["a/z", "a", "a0", "b/x", "a/b", "a/\uffff/tail"])
        await store.save(key, new Uint8Array())
      expect(await store.list("a/")).toEqual(["a/b", "a/z", "a/\uffff/tail"])
      expect(await store.list("absent")).toEqual([])
      expect(await store.list("")).toEqual([
        "a",
        "a/b",
        "a/z",
        "a/\uffff/tail",
        "a0",
        "b/x",
      ])
    })

    it("loads every entry under an exact prefix, sorted, in one read", async () => {
      for (const [key, value] of [
        ["a/z", 1],
        ["a", 2],
        ["a0", 3],
        ["b/x", 4],
        ["a/b", 5],
        ["a/\uffff/tail", 6],
      ] as const)
        await store.save(key, new Uint8Array([value]))
      // `a/` must not match `a` or `a0`, and keys containing \uffff are kept.
      expect(await store.loadPrefix("a/")).toEqual([
        ["a/b", new Uint8Array([5])],
        ["a/z", new Uint8Array([1])],
        ["a/\uffff/tail", new Uint8Array([6])],
      ])
      expect(await store.loadPrefix("absent")).toEqual([])
      expect((await store.loadPrefix("")).map(([key]) => key)).toEqual(
        await store.list("")
      )
    })

    it("loadPrefix returns one consistent cut despite concurrent writes", async () => {
      await store.save("p/a", new Uint8Array([1]))
      await store.save("p/b", new Uint8Array([2]))
      const reading = store.loadPrefix("p/")
      const removing = store.remove("p/a")
      const replacing = store.save("p/b", new Uint8Array([3]))
      const entries = await reading
      await Promise.all([removing, replacing])
      // Either the whole cut predates the writes or follows them; never a mix
      // and never a missing value for a listed key.
      expect([
        JSON.stringify([
          ["p/a", [1]],
          ["p/b", [2]],
        ]),
        JSON.stringify([["p/b", [3]]]),
      ]).toContain(
        JSON.stringify(entries.map(([key, value]) => [key, [...value]]))
      )
    })

    it("keeps prefix reads exact across overwrites, removes and re-saves", async () => {
      const expected = new Map<string, number>()
      const keys = ["t/a", "t/b", "t/c", "t", "u/a", "t/a/x"]
      for (let step = 0; step < 60; step++) {
        const key = keys[(step * 7) % keys.length]
        if (step % 3 === 2) {
          await store.remove(key)
          expected.delete(key)
        } else {
          await store.save(key, new Uint8Array([step]))
          expected.set(key, step)
        }
        const want = [...expected]
          .filter(([k]) => k.startsWith("t/"))
          .sort(([a], [b]) => (a < b ? -1 : 1))
        expect(await store.list("t/")).toEqual(want.map(([k]) => k))
        expect(await store.loadPrefix("t/")).toEqual(
          want.map(([k, v]) => [k, new Uint8Array([v])])
        )
      }
    })

    it("returns loadPrefix bytes the caller owns", async () => {
      await store.save("p/key", new Uint8Array([1]))
      const [[, loaded]] = await store.loadPrefix("p/")
      loaded[0] = 9
      expect(await store.load("p/key")).toEqual(new Uint8Array([1]))
    })

    it("does not alias bytes supplied to or returned from the store", async () => {
      const value = new Uint8Array([1])
      await store.save("key", value)
      value[0] = 2
      const loaded = (await store.load("key"))!
      expect(loaded).toEqual(new Uint8Array([1]))
      loaded[0] = 3
      expect(await store.load("key")).toEqual(new Uint8Array([1]))
    })

    it("snapshots save bytes before the promise settles", async () => {
      const value = new Uint8Array([1])
      const saving = store.save("key", value)
      value[0] = 2
      await saving
      expect(await store.load("key")).toEqual(new Uint8Array([1]))
    })

    it("saves a batch as one visible cut and snapshots its bytes", async () => {
      await store.save("b/1", new Uint8Array([0]))
      const one = new Uint8Array([1])
      const saving = store.saveBatch([
        ["b/1", one],
        ["b/2", new Uint8Array([2])],
        ["b/3", new Uint8Array([3])],
      ])
      const reading = store.loadPrefix("b/")
      one[0] = 9
      const seen = await reading
      await saving
      // A concurrent read sees the whole batch or none of it.
      expect([
        JSON.stringify([["b/1", [0]]]),
        JSON.stringify([
          ["b/1", [1]],
          ["b/2", [2]],
          ["b/3", [3]],
        ]),
      ]).toContain(
        JSON.stringify(seen.map(([key, value]) => [key, [...value]]))
      )
      expect(await store.loadPrefix("b/")).toEqual([
        ["b/1", new Uint8Array([1])],
        ["b/2", new Uint8Array([2])],
        ["b/3", new Uint8Array([3])],
      ])
      await store.saveBatch([])
    })
  })
}

describe("IndexedDBByteStore", () => {
  it("snapshots Buffer input rather than retaining its aliased slice", async () => {
    const store = new IndexedDBByteStore()
    try {
      const value = Buffer.from([1])
      const saving = store.save("key", value)
      value[0] = 2
      await saving
      expect(await store.load("key")).toEqual(new Uint8Array([1]))
    } finally {
      await store.close()
    }
  })

  it("opens lazily without requiring IndexedDB at construction", async () => {
    vi.stubGlobal("indexedDB", undefined)
    const store = new IndexedDBByteStore()
    await store.close()
    await expect(store.load("key")).rejects.toBeDefined()
  })

  it("uses the package database by default and survives close/reopen", async () => {
    const store = new IndexedDBByteStore()
    try {
      await store.save("key", new Uint8Array([7]))
      expect(await indexedDB.databases()).toContainEqual(
        expect.objectContaining({ name: "automerge-repo-subduction" })
      )
      await store.close()
      expect(await store.load("key")).toEqual(new Uint8Array([7]))
      await store.close()
      const another = new IndexedDBByteStore()
      try {
        expect(await another.load("key")).toEqual(new Uint8Array([7]))
      } finally {
        await another.close()
      }
    } finally {
      await store.close()
    }
  })

  it("isolates database names", async () => {
    const first = new IndexedDBByteStore({ database: "first" })
    const second = new IndexedDBByteStore({ database: "second" })
    try {
      await first.save("key", new Uint8Array([1]))
      expect(await second.load("key")).toBeUndefined()
    } finally {
      await Promise.all([first.close(), second.close()])
    }
  })

  it("adds a custom store to an existing database without losing other data", async () => {
    const original = new IndexedDBByteStore({ database: "shared-schema" })
    const custom = new IndexedDBByteStore({
      database: "shared-schema",
      store: "other",
    })
    try {
      await original.save("one", new Uint8Array([1]))
      await original.close()
      await custom.save("two", new Uint8Array([2]))
      expect(await custom.load("two")).toEqual(new Uint8Array([2]))
      expect(await original.load("one")).toEqual(new Uint8Array([1]))
    } finally {
      await Promise.all([original.close(), custom.close()])
    }
  })

  it.each([{ keyPath: "id" }, { autoIncrement: true }])(
    "rejects an incompatible custom object store: %j",
    async options => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("invalid-schema")
        request.onupgradeneeded = () =>
          request.result.createObjectStore("other", options)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      db.close()
      const store = new IndexedDBByteStore({
        database: "invalid-schema",
        store: "other",
      })
      await expect(store.save("key", new Uint8Array([1]))).rejects.toThrow(
        "Invalid IndexedDB object store invalid-schema/other: expected out-of-line keys without autoIncrement"
      )
      await store.close()
    }
  )

  it("reopens after another client upgrades the database version", async () => {
    const store = new IndexedDBByteStore({ database: "upgraded" })
    try {
      await store.save("key", new Uint8Array([3]))
      const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("upgraded", 2)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      upgraded.close()
      expect(await store.load("key")).toEqual(new Uint8Array([3]))
    } finally {
      await store.close()
    }
  })

  it("reopens after unexpected database closure", async () => {
    const open = vi.spyOn(indexedDB, "open")
    const store = new IndexedDBByteStore({ database: "force-closed" })
    try {
      await store.save("key", new Uint8Array([3]))
      const db = open.mock.results[0].value.result as IDBDatabase
      const closed = new Promise<void>(resolve =>
        db.addEventListener("close", () => resolve(), { once: true })
      )
      // fake-indexeddb 6.2.5 types this instance parameter as a constructor.
      forceCloseDatabase(
        db as unknown as Parameters<typeof forceCloseDatabase>[0]
      )
      await closed
      expect(await store.load("key")).toEqual(new Uint8Array([3]))
      expect(open).toHaveBeenCalledTimes(2)
    } finally {
      await store.close()
    }
  })

  it("closes eventual success of an abandoned blocked open and allows retry", async () => {
    const blocker = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("blocked")
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const open = vi.spyOn(indexedDB, "open")
    const store = new IndexedDBByteStore({ database: "blocked" })
    try {
      await expect(store.load("key")).rejects.toThrow(
        "IndexedDB open blocked: blocked"
      )
      const request = open.mock.results[1].value as IDBOpenDBRequest
      const success = new Promise<void>(resolve =>
        request.addEventListener("success", () => resolve(), { once: true })
      )
      blocker.close()
      await success
      expect(() => request.result.transaction("bytes")).toThrow()
      await expect(store.load("key")).resolves.toBeUndefined()
    } finally {
      blocker.close()
      await store.close()
    }
  })

  it("closes an in-flight database open without hanging", async () => {
    const store = new IndexedDBByteStore({ database: "closing" })
    const pending = store.load("key")
    await store.close()
    await expect(pending).rejects.toBeDefined()
    await expect(store.load("key")).resolves.toBeUndefined()
    await store.close()
  })

  it("allows retry after a database open failure", async () => {
    const store = new IndexedDBByteStore()
    const open = vi.spyOn(indexedDB, "open").mockImplementationOnce(() => {
      throw new Error("unavailable")
    })
    await expect(store.load("key")).rejects.toThrow("unavailable")
    open.mockRestore()
    try {
      await expect(store.load("key")).resolves.toBeUndefined()
    } finally {
      await store.close()
    }
  })

  it("rejects a save aborted after request success without replacing the value", async () => {
    const open = vi.spyOn(indexedDB, "open")
    const store = new IndexedDBByteStore({ database: "aborted" })
    try {
      await store.save("key", new Uint8Array([1]))
      const db = open.mock.results[0].value.result as IDBDatabase
      const transaction = db.transaction.bind(db)
      vi.spyOn(db, "transaction").mockImplementationOnce((...args) => {
        const tx = transaction(...args)
        const objectStore = tx.objectStore("bytes")
        const put = objectStore.put.bind(objectStore)
        vi.spyOn(tx, "objectStore").mockReturnValue(objectStore)
        vi.spyOn(objectStore, "put").mockImplementationOnce((...putArgs) => {
          const request = put(...putArgs)
          request.addEventListener("success", () => tx.abort(), { once: true })
          return request
        })
        return tx
      })
      await expect(store.save("key", new Uint8Array([2]))).rejects.toThrow(
        "IndexedDB transaction failed"
      )
      expect(await store.load("key")).toEqual(new Uint8Array([1]))
      await store.save("key", new Uint8Array([3]))
      expect(await store.load("key")).toEqual(new Uint8Array([3]))
    } finally {
      await store.close()
    }
  })

  it("commits none of a batch whose transaction aborts part-way", async () => {
    const open = vi.spyOn(indexedDB, "open")
    const store = new IndexedDBByteStore({ database: "batch-aborted" })
    try {
      await store.save("a", new Uint8Array([1]))
      const db = open.mock.results[0].value.result as IDBDatabase
      const transaction = db.transaction.bind(db)
      vi.spyOn(db, "transaction").mockImplementationOnce((...args) => {
        const tx = transaction(...args)
        const objectStore = tx.objectStore("bytes")
        const put = objectStore.put.bind(objectStore)
        let puts = 0
        vi.spyOn(tx, "objectStore").mockReturnValue(objectStore)
        vi.spyOn(objectStore, "put").mockImplementation((...putArgs) => {
          const request = put(...putArgs)
          // The first two puts succeed; the transaction aborts on the third.
          if (++puts === 3)
            request.addEventListener("success", () => tx.abort(), {
              once: true,
            })
          return request
        })
        return tx
      })
      await expect(
        store.saveBatch([
          ["a", new Uint8Array([2])],
          ["b", new Uint8Array([2])],
          ["c", new Uint8Array([2])],
        ])
      ).rejects.toThrow("IndexedDB transaction failed")
      expect(await store.loadPrefix("")).toEqual([["a", new Uint8Array([1])]])
      await store.saveBatch([["b", new Uint8Array([3])]])
      expect(await store.load("b")).toEqual(new Uint8Array([3]))
    } finally {
      await store.close()
    }
  })

  it("commits none of a batch when a later put throws synchronously", async () => {
    const store = new IndexedDBByteStore({ database: "batch-invalid-key" })
    try {
      await store.save("a", new Uint8Array([1]))
      await expect(
        store.saveBatch([
          ["a", new Uint8Array([2])],
          [undefined as unknown as string, new Uint8Array([3])],
        ])
      ).rejects.toMatchObject({ name: "DataError" })
      expect(await store.loadPrefix("")).toEqual([["a", new Uint8Array([1])]])
    } finally {
      await store.close()
    }
  })

  it("rejects request failure after transaction abort and allows another save", async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("request-failure")
      request.onupgradeneeded = () => {
        request.result
          .createObjectStore("bytes")
          .createIndex("uniqueBytes", "", { unique: true })
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    db.close()
    const store = new IndexedDBByteStore({ database: "request-failure" })
    try {
      await store.save("first", new Uint8Array([1]))
      await expect(
        store.save("second", new Uint8Array([1]))
      ).rejects.toMatchObject({
        name: "ConstraintError",
      })
      expect(await store.load("second")).toBeUndefined()
      await store.save("second", new Uint8Array([2]))
      expect(await store.load("second")).toEqual(new Uint8Array([2]))
    } finally {
      await store.close()
    }
  })

  it("rejects non-byte values instead of treating them as missing", async () => {
    const store = new IndexedDBByteStore({ database: "invalid-value" })
    try {
      await store.save("key", new Uint8Array([1]))
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("invalid-value", 1)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      try {
        const transaction = db.transaction("bytes", "readwrite")
        transaction.objectStore("bytes").put("not bytes", "key")
        await new Promise<void>((resolve, reject) => {
          transaction.oncomplete = () => resolve()
          transaction.onabort = () => reject(transaction.error)
        })
      } finally {
        db.close()
      }
      await expect(store.load("key")).rejects.toThrow(
        "Invalid IndexedDB byte value"
      )
    } finally {
      await store.close()
    }
  })

  it("reloads native records from a new backend after the old backend closes", async () => {
    const signer = N.MemorySigner.generate()
    const storage = new IndexedDBByteStore({ database: "backend" })
    const id = sedimentreeId("ab".repeat(16))
    const record: LooseCommitRecord = {
      kind: "commit",
      id: commitId("01".padStart(64, "0")),
      parents: [],
      blob: new Uint8Array([1, 42]),
    }
    const first = new SubductionBackend({ storage, signer })
    try {
      await first.store(id, [record])
      await first.close()
      await storage.close()
      const reopened = new IndexedDBByteStore({ database: "backend" })
      const second = new SubductionBackend({ storage: reopened, signer })
      try {
        const iterator = second.open(id).events[Symbol.asyncIterator]()
        const seen: LooseCommitRecord[] = []
        for (;;) {
          const next = await iterator.next()
          if (next.done) throw new Error("Session ended before local load")
          if (next.value.type === "failure") throw next.value.error
          if (next.value.type === "records")
            seen.push(...(next.value.records as LooseCommitRecord[]))
          if (next.value.type === "local-load-complete") break
        }
        expect(seen).toEqual([record])
      } finally {
        await second.close()
        await reopened.close()
      }
    } finally {
      await first.close()
      await storage.close()
      signer.free()
    }
  })
})
