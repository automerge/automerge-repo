import { next as A } from "@automerge/automerge"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Repo } from "../src/Repo.js"
import { DocHandle } from "../src/DocHandle.js"
import { Document } from "../src/Document.js"
import { documentIdToBinary } from "../src/AutomergeUrl.js"
import { MemoryBackend } from "../src/sedimentree/testing/MemoryBackend.js"
import { sedimentreeId, type SedimentreeId } from "../src/sedimentree/index.js"
import { applyRecords } from "../src/sedimentree/automerge/index.js"
import type { DocumentId } from "../src/types.js"
import { scriptedBackend } from "./helpers/scriptedBackend.js"

type Doc = { count: number; nested?: { value: number } }

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(r => {
    resolve = r
  })
  return { promise, resolve }
}

const treeId = (handle: DocHandle<any>): SedimentreeId =>
  sedimentreeId(documentIdToBinary(handle.documentId)!)

describe("Repo persistence", () => {
  const repos: Repo[] = []
  const repo = (backend: MemoryBackend) => {
    const result = new Repo({ backend })
    repos.push(result)
    return result
  }
  afterEach(async () => {
    await Promise.all(repos.splice(0).map(r => r.shutdown()))
    vi.restoreAllMocks()
  })

  describe("writes", () => {
    it("mutates and emits immediately, resolves change only after persistence", async () => {
      const backend = new MemoryBackend()
      const blocked = gate()
      const store = backend.store.bind(backend)
      const r = repo(backend)
      const handle = await r.create<Doc>({ count: 0 })
      vi.spyOn(backend, "store").mockImplementationOnce(async (id, batch) => {
        await blocked.promise
        return store(id, batch)
      })
      const listener = vi.fn()
      handle.on("change", listener)
      let completed = false
      const write = handle
        .change(d => {
          d.count = 1
        })
        .then(() => {
          completed = true
        })
      expect(handle.doc()?.count).toBe(1)
      expect(listener).toHaveBeenCalledOnce()
      await Promise.resolve()
      expect(completed).toBe(false)
      blocked.resolve()
      await write
      expect(completed).toBe(true)
    })

    it("starts the first store synchronously during change()", async () => {
      const backend = new MemoryBackend()
      const r = repo(backend)
      const handle = await r.create<Doc>({ count: 0 })
      const store = vi.spyOn(backend, "store")
      const write = handle.change(d => {
        d.count = 1
      })
      expect(store).toHaveBeenCalledOnce()
      await write
    })

    it("stores each edit at once, without waiting for an earlier store", async () => {
      const backend = new MemoryBackend()
      const blocked = gate()
      const store = backend.store.bind(backend)
      const r = repo(backend)
      const handle = await r.create<Doc>({ count: 0 })
      const spy = vi
        .spyOn(backend, "store")
        .mockImplementationOnce(async (id, batch) => {
          await blocked.promise
          return store(id, batch)
        })
      let firstDone = false
      const first = handle
        .change(d => {
          d.count = 1
        })
        .then(() => {
          firstDone = true
        })
      const second = handle.change(d => {
        d.count = 2
      })
      expect(spy).toHaveBeenCalledTimes(2)
      expect(spy.mock.calls[1][1]).toHaveLength(1)
      await second
      expect(firstDone).toBe(false)
      blocked.resolve()
      await first
      expect(await backendDoc(backend, handle)).toEqual({ count: 2 })
    })

    it("writes only the new change and does not resubmit an unchanged document", async () => {
      const backend = new MemoryBackend()
      const r = repo(backend)
      const handle = await r.create<Doc>({ count: 0 })
      const store = vi.spyOn(backend, "store")
      await handle.change(doc => {
        doc.count = 1
      })
      expect(store.mock.calls[0][1]).toHaveLength(1)
      await handle.change(doc => {
        doc.count = 1
      })
      expect(store).toHaveBeenCalledTimes(1)
    })

    it("captures change, changeAt, merge, and scoped removal", async () => {
      const backend = new MemoryBackend()
      const r = repo(backend)
      const handle = await r.create<Doc>({ count: 0, nested: { value: 1 } })
      const store = vi.spyOn(backend, "store")
      const heads = handle.heads()
      await handle.change(d => {
        d.count = 1
      })
      expect(await handle.changeAt(heads, d => (d.count = 2))).toBeDefined()
      await r.flush()
      const other = new DocHandle(
        new Document(
          "other" as DocumentId,
          A.change(A.clone(handle.fullDoc()), d => {
            d.count = 3
          })
        )
      )
      await handle.merge(other)
      await handle.sub("nested").remove()
      expect(store).toHaveBeenCalledTimes(4)
      expect(handle.doc()?.nested).toBeUndefined()
    })

    it("rejects later edits after a failed write, without applying or storing them", async () => {
      const backend = new MemoryBackend()
      const r = repo(backend)
      const handle = await r.create<Doc>({ count: 0 })
      const store = vi
        .spyOn(backend, "store")
        .mockRejectedValueOnce(new Error("disk full"))
      await expect(
        handle.change(d => {
          d.count = 1
        })
      ).rejects.toThrow("disk full")
      const heads = handle.heads()
      await expect(
        handle.change(d => {
          d.count = 2
        })
      ).rejects.toThrow("disk full")
      await expect(
        handle.changeAt(heads, d => {
          d.count = 3
        })
      ).rejects.toThrow("disk full")
      expect(handle.heads()).toEqual(heads)
      expect(handle.doc()).toEqual({ count: 1 })
      expect(store).toHaveBeenCalledOnce()
    })

    it("rejects changeAt when its own write fails, keeping the edit", async () => {
      const backend = new MemoryBackend()
      const r = repo(backend)
      const handle = await r.create<Doc>({ count: 0 })
      const heads = handle.heads()
      vi.spyOn(backend, "store").mockRejectedValueOnce(new Error("disk full"))
      await expect(
        handle.changeAt(heads, d => {
          d.count = 1
        })
      ).rejects.toThrow("disk full")
      expect(handle.doc()).toEqual({ count: 1 })
    })

    it("does not batch edits made during a store; a failure blocks only that document", async () => {
      const backend = new MemoryBackend()
      const blocked = gate()
      const r = repo(backend)
      const handle = await r.create<Doc>({ count: 0 })
      const other = await r.create<Doc>({ count: 0 })
      const store = vi
        .spyOn(backend, "store")
        .mockImplementationOnce(async () => {
          await blocked.promise
          throw new Error("disk full")
        })
      const first = expect(
        handle.change(d => {
          d.count = 1
        })
      ).rejects.toThrow("disk full")
      const second = handle.change(d => {
        d.count = 2
      })
      const third = handle.change(d => {
        d.count = 3
      })
      await other.change(d => {
        d.count = 4
      })
      await Promise.all([second, third])
      expect(store.mock.calls.map(([id]) => id)).toEqual([
        treeId(handle),
        treeId(handle),
        treeId(handle),
        treeId(other),
      ])
      expect(store.mock.calls.map(([, batch]) => batch.length)).toEqual([
        1, 1, 1, 1,
      ])
      blocked.resolve()
      await first
      await expect(
        handle.change(d => {
          d.count = 5
        })
      ).rejects.toThrow("disk full")
      await other.change(d => {
        d.count = 5
      })
      expect(store).toHaveBeenCalledTimes(5)
      await expect(r.flush()).rejects.toThrow("Repo flush failed")
      await r.flush([other.documentId])
    })

    it("skips known-head echoes without applying or acknowledging them", async () => {
      const { backend, session } = scriptedBackend()
      const r = repo(backend)
      const handle = await r.create<Doc>({ count: 0 })
      const current = await session()
      let reject!: (error: Error) => void
      const store = vi.spyOn(backend, "store").mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, fail) => {
            reject = fail
          })
      )
      const changed = vi.fn()
      handle.on("change", changed)
      const pending = handle.change(d => {
        d.count = 1
      })
      await vi.waitFor(() => expect(store).toHaveBeenCalledOnce())
      const echoed = store.mock.calls[0][1]
      const before = handle.fullDoc()
      await current.push({
        type: "records",
        records: echoed,
        phase: "live",
        sequence: 1,
      })
      expect(handle.fullDoc()).toBe(before)
      expect(changed).toHaveBeenCalledOnce()
      reject(new Error("storage failed"))
      await expect(pending).rejects.toThrow("storage failed")
      await expect(r.flush()).rejects.toThrow("Repo flush failed")
      expect(store).toHaveBeenCalledOnce()
    })
  })

  describe("flush", () => {
    it("captures accepted writes, not subsequent edits", async () => {
      const backend = new MemoryBackend()
      const firstGate = gate()
      const laterGate = gate()
      const store = backend.store.bind(backend)
      const r = repo(backend)
      const handle = await r.create<Doc>({ count: 0 })
      const spy = vi
        .spyOn(backend, "store")
        .mockImplementationOnce(async (id, batch) => {
          await firstGate.promise
          return store(id, batch)
        })
        .mockImplementationOnce(async (id, batch) => {
          await laterGate.promise
          return store(id, batch)
        })
      const first = handle.change(d => {
        d.count = 1
      })
      await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce())
      const flushed = r.flush()
      const later = handle.change(d => {
        d.count = 2
      })
      firstGate.resolve()
      await flushed
      await first
      expect(spy).toHaveBeenCalledTimes(2)
      laterGate.resolve()
      await later
    })

    it("rejects with a failed write, and keeps rejecting without retrying", async () => {
      const backend = new MemoryBackend()
      const r = repo(backend)
      const handle = await r.create<Doc>({ count: 0 })
      const store = vi
        .spyOn(backend, "store")
        .mockRejectedValueOnce(new Error("disk full"))
      const failed = expect(
        handle.change(d => {
          d.count = 1
        })
      ).rejects.toThrow("disk full")
      const flush = r.flush()
      await failed
      for (const attempt of [flush, r.flush(), r.flush([handle.documentId])])
        await expect(attempt).rejects.toMatchObject({
          message: "Repo flush failed",
          errors: [expect.objectContaining({ message: "disk full" })],
        })
      expect(store).toHaveBeenCalledOnce()
      expect(await backendDoc(backend, handle)).toEqual({ count: 0 })
    })

    it("does not hide opaque backend flush failures after store recovery", async () => {
      const backend = new MemoryBackend()
      const r = repo(backend)
      const handle = await r.create<Doc>({ count: 0 })
      vi.spyOn(backend, "store").mockRejectedValueOnce(
        new Error("store failed")
      )
      vi.spyOn(backend, "flush").mockRejectedValueOnce(
        new Error("barrier failed")
      )
      const rejected = expect(
        handle.change(d => {
          d.count = 1
        })
      ).rejects.toThrow("store failed")
      const flush = r.flush()
      await rejected
      await expect(flush).rejects.toThrow("Repo flush failed")
    })

    it("flush(ids) drains only the targeted documents", async () => {
      const backend = new MemoryBackend()
      const blocked = gate()
      const store = backend.store.bind(backend)
      const r = repo(backend)
      const first = await r.create<Doc>({ count: 0 })
      const second = await r.create<Doc>({ count: 0 })
      vi.spyOn(backend, "store").mockImplementation(async (id, batch) => {
        if (id === treeId(second)) await blocked.promise
        return store(id, batch)
      })
      const flush = vi.spyOn(backend, "flush")
      const write = first.change(d => {
        d.count = 1
      })
      const slow = second.change(d => {
        d.count = 1
      })
      await r.flush([first.documentId])
      expect(flush).toHaveBeenCalledWith([treeId(first)])
      await write
      blocked.resolve()
      await slow
    })

    it("captures the backend barrier synchronously when nothing is pending", async () => {
      const backend = new MemoryBackend()
      const pending: Promise<void>[] = []
      const barriers: Promise<void>[][] = []
      const r = repo(backend)
      const handle = await r.create<Doc>({ count: 0 })
      vi.spyOn(backend, "flush").mockImplementation(() => {
        const captured = [...pending]
        barriers.push(captured)
        return Promise.all(captured).then(() => {})
      })
      const first = gate()
      pending.push(first.promise)
      const flush = r.flush()
      expect(barriers).toEqual([[first.promise]])
      const later = gate()
      pending.push(later.promise)
      const write = handle.change(d => {
        d.count = 1
      })
      first.resolve()
      await flush
      await write
      later.resolve()
    })

    it("captures the backend barrier at call time and waits for pending stores, not later ones", async () => {
      const backend = new MemoryBackend()
      const blocked = gate()
      const later = gate()
      const store = backend.store.bind(backend)
      const r = repo(backend)
      const handle = await r.create<Doc>({ count: 0 })
      let count = 0
      const spy = vi
        .spyOn(backend, "store")
        .mockImplementation(async (id, batch) => {
          await (++count === 1 ? blocked.promise : later.promise)
          return store(id, batch)
        })
      const barrier = vi.spyOn(backend, "flush")
      const first = handle.change(d => {
        d.count = 1
      })
      await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce())
      const flushing = r.flush()
      expect(barrier).toHaveBeenCalledExactlyOnceWith(undefined)
      const second = handle.change(d => {
        d.count = 2
      })
      let settled = false
      void flushing.then(() => {
        settled = true
      })
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(settled).toBe(false)
      blocked.resolve()
      await first
      await flushing
      later.resolve()
      await second
    })
  })

  describe("removeFromCache", () => {
    it("drains writes and closes interest without deleting history", async () => {
      const backend = new MemoryBackend()
      const blocked = gate()
      const store = backend.store.bind(backend)
      const r = repo(backend)
      const handle = await r.create<Doc>({ count: 0 })
      vi.spyOn(backend, "store").mockImplementationOnce(async (id, batch) => {
        await blocked.promise
        return store(id, batch)
      })
      const deleted = vi.spyOn(backend, "deleteLocal")
      const write = handle.change(d => {
        d.count = 9
      })
      const evicted = r.removeFromCache(handle.documentId)
      expect(() =>
        handle.change(d => {
          d.count = 10
        })
      ).toThrow("closed")
      blocked.resolve()
      await write
      await evicted
      expect(deleted).not.toHaveBeenCalled()
      expect(handle.isDeleted()).toBe(false)
      expect(r.handles[handle.documentId]).toBeUndefined()
      expect(await backendDoc(backend, handle)).toEqual({ count: 9 })
      const reopened = await r.find<Doc>(handle.url)
      expect(reopened).not.toBe(handle)
      expect(reopened.doc()).toEqual({ count: 9 })
    })

    it("refuses eviction after a failed write, without retrying it", async () => {
      const backend = new MemoryBackend()
      const store = backend.store.bind(backend)
      const r = repo(backend)
      const handle = await r.create<Doc>({ count: 0 })
      const attempts = vi
        .spyOn(backend, "store")
        .mockRejectedValueOnce(new Error("disk full"))
      await expect(
        handle.change(d => {
          d.count = 1
        })
      ).rejects.toThrow("disk full")
      attempts.mockImplementation(store)
      for (let i = 0; i < 2; i++) {
        await expect(r.removeFromCache(handle.documentId)).rejects.toThrow(
          "Repo flush failed"
        )
        expect(r.handles[handle.documentId]).toBe(handle)
      }
      expect(attempts).toHaveBeenCalledOnce()
    })

    it("keeps the entry when the backend barrier fails, and can retry", async () => {
      const backend = new MemoryBackend()
      const r = repo(backend)
      const handle = await r.create<Doc>({ count: 0 })
      const flush = vi
        .spyOn(backend, "flush")
        .mockRejectedValueOnce(new Error("barrier failed"))
      await expect(r.removeFromCache(handle.documentId)).rejects.toMatchObject({
        errors: [expect.objectContaining({ message: "barrier failed" })],
      })
      expect(r.handles[handle.documentId]).toBe(handle)
      await r.removeFromCache(handle.documentId)
      expect(flush).toHaveBeenCalledTimes(2)
      expect(flush).toHaveBeenLastCalledWith([treeId(handle)])
      expect(r.handles[handle.documentId]).toBeUndefined()
    })

    it("retains a session whose close failed, so cleanup can be retried", async () => {
      const { backend, session } = scriptedBackend()
      const r = repo(backend)
      const handle = await r.create<Doc>({ count: 0 })
      const current = await session()
      current.close.mockRejectedValueOnce(new Error("close failed"))
      await expect(r.removeFromCache(handle.documentId)).rejects.toThrow(
        "close failed"
      )
      await r.removeFromCache(handle.documentId)
      expect(current.close).toHaveBeenCalledTimes(2)
    })
  })

  describe("delete", () => {
    it("stops producers, drains earlier work, then deletes", async () => {
      const backend = new MemoryBackend()
      const blocked = gate()
      const store = backend.store.bind(backend)
      const r = repo(backend)
      const handle = await r.create<Doc>({ count: 0 })
      vi.spyOn(backend, "store").mockImplementationOnce(async (id, batch) => {
        await blocked.promise
        return store(id, batch)
      })
      const deleted = vi.spyOn(backend, "deleteLocal")
      const removed = vi.fn()
      r.on("delete-document", removed)
      const write = handle.change(d => {
        d.count = 1
      })
      const deletion = r.delete(handle.documentId)
      expect(handle.isDeleted()).toBe(true)
      expect(() =>
        handle.change(d => {
          d.count = 2
        })
      ).toThrow("deleted")
      await expect(r.find(handle.url)).rejects.toThrow("deletion in progress")
      await expect(r.create()).resolves.toBeDefined()
      expect(deleted).not.toHaveBeenCalled()
      blocked.resolve()
      await write
      await deletion
      expect(deleted).toHaveBeenCalledExactlyOnceWith(treeId(handle))
      expect(removed).toHaveBeenCalledExactlyOnceWith({
        documentId: handle.documentId,
      })
      expect(r.handles[handle.documentId]).toBeUndefined()
      expect(await backendDoc(backend, handle)).toBeUndefined()
    })

    it("does not retry a failed write of a deleted document", async () => {
      const backend = new MemoryBackend()
      const r = repo(backend)
      const handle = await r.create<Doc>({ count: 0 })
      const store = vi
        .spyOn(backend, "store")
        .mockRejectedValueOnce(new Error("disk full"))
      await expect(
        handle.change(d => {
          d.count = 1
        })
      ).rejects.toThrow("disk full")
      await r.delete(handle.documentId)
      await r.flush()
      expect(store).toHaveBeenCalledTimes(1)
      expect(await backendDoc(backend, handle)).toBeUndefined()
    })

    it("lets the stores in flight finish, then deletes", async () => {
      const backend = new MemoryBackend()
      const blocked = gate()
      const store = backend.store.bind(backend)
      const r = repo(backend)
      const handle = await r.create<Doc>({ count: 0 })
      const spy = vi
        .spyOn(backend, "store")
        .mockImplementationOnce(async (id, batch) => {
          await blocked.promise
          return store(id, batch)
        })
      const deleted = vi.spyOn(backend, "deleteLocal")
      const first = handle.change(d => {
        d.count = 1
      })
      expect(spy).toHaveBeenCalledOnce()
      const second = handle.change(d => {
        d.count = 2
      })
      expect(spy).toHaveBeenCalledTimes(2)
      const deletion = r.delete(handle.documentId)
      blocked.resolve()
      await Promise.all([first, second])
      await deletion
      expect(spy).toHaveBeenCalledTimes(2)
      expect(deleted).toHaveBeenCalledOnce()
      expect(await backendDoc(backend, handle)).toBeUndefined()
    })

    it("stores nothing more once the backend observes a deletion", async () => {
      const { backend, session } = scriptedBackend()
      const blocked = gate()
      const r = repo(backend)
      const handle = await r.create<Doc>({ count: 0 })
      const current = await session()
      const spy = vi
        .spyOn(backend, "store")
        .mockImplementationOnce(() => blocked.promise)
      const first = handle.change(d => {
        d.count = 1
      })
      await current.end({ type: "deleted", sequence: 1 })
      expect(handle.isDeleted()).toBe(true)
      blocked.resolve()
      await first
      expect(spy).toHaveBeenCalledTimes(1)
      await r.flush()
      expect(spy).toHaveBeenCalledTimes(1)
    })

    it("still deletes, and reports, when the session cannot be closed", async () => {
      const { backend, session } = scriptedBackend()
      const r = repo(backend)
      const handle = await r.create<Doc>({ count: 0 })
      const current = await session()
      current.close.mockRejectedValueOnce(new Error("close failed"))
      const deleted = vi.spyOn(backend, "deleteLocal")
      const deletion = r.delete(handle.documentId)
      await expect(deletion).rejects.toThrow("Document deletion failed")
      await expect(deletion).rejects.toMatchObject({
        errors: [expect.objectContaining({ message: "close failed" })],
      })
      expect(deleted).toHaveBeenCalledOnce()
      expect(handle.isDeleted()).toBe(true)
    })

    it("fences lookups from reentrant delete listeners and deletes once", async () => {
      const backend = new MemoryBackend()
      const r = repo(backend)
      const handle = await r.create<Doc>({ count: 0 })
      const deleted = vi.spyOn(backend, "deleteLocal")
      let reentrant!: Promise<unknown>
      handle.on("delete", () => {
        reentrant = r.find(handle.url)
      })
      const deletion = r.delete(handle.documentId)
      expect(r.delete(handle.documentId)).toBe(deletion)
      await expect(reentrant).rejects.toThrow("deletion in progress")
      await deletion
      expect(deleted).toHaveBeenCalledOnce()
    })

    it("deletes an ID that is not open without opening a session", async () => {
      const backend = new MemoryBackend()
      const r = repo(backend)
      const handle = await r.create<Doc>({ count: 1 })
      await r.removeFromCache(handle.documentId)
      const open = vi.spyOn(backend, "open")
      await r.delete(handle.documentId)
      expect(open).not.toHaveBeenCalled()
      expect(await backendDoc(backend, handle)).toBeUndefined()
    })

    it("marks the document deleted when the backend observes a deletion", async () => {
      const backend = new MemoryBackend()
      const r = repo(backend)
      const handle = await r.create<Doc>({ count: 1 })
      const removed = vi.fn()
      r.on("delete-document", removed)
      await backend.deleteLocal(treeId(handle))
      await vi.waitFor(() => expect(handle.isDeleted()).toBe(true))
      expect(removed).toHaveBeenCalledExactlyOnceWith({
        documentId: handle.documentId,
      })
      expect(r.handles[handle.documentId]).toBeUndefined()
    })
  })

  describe("shutdown", () => {
    it("drains a pending creation and rejects new work immediately", async () => {
      const backend = new MemoryBackend()
      const blocked = gate()
      const create = backend.create.bind(backend)
      vi.spyOn(backend, "create").mockImplementationOnce(
        async (batch, options) => {
          await blocked.promise
          return create(batch, options)
        }
      )
      const close = vi.spyOn(backend, "close")
      const r = repo(backend)
      const creation = r.create<Doc>({ count: 0 })
      const shutdown = r.shutdown()
      expect(r.shutdown()).toBe(shutdown)
      await expect(r.create()).rejects.toThrow("shut down")
      expect(close).not.toHaveBeenCalled()
      blocked.resolve()
      // The history is stored, but no handle is issued after shutdown began.
      await expect(creation).rejects.toThrow("shut down")
      await shutdown
      expect(close).toHaveBeenCalledOnce()
    })

    it("does not retry a failed write at shutdown", async () => {
      const backend = new MemoryBackend()
      const r = repo(backend)
      const handle = await r.create<Doc>({ count: 0 })
      const attempts = vi
        .spyOn(backend, "store")
        .mockRejectedValueOnce(new Error("disk full"))
      await expect(
        handle.change(d => {
          d.count = 1
        })
      ).rejects.toThrow("disk full")
      await r.shutdown()
      expect(attempts).toHaveBeenCalledOnce()
      expect(() =>
        handle.change(d => {
          d.count = 2
        })
      ).toThrow("closed")
    })

    it("waits for a store pending at shutdown without retrying it", async () => {
      const backend = new MemoryBackend()
      const r = repo(backend)
      const handle = await r.create<Doc>({ count: 0 })
      const store = vi
        .spyOn(backend, "store")
        .mockRejectedValueOnce(new Error("disk full"))
      const failed = expect(
        handle.change(d => {
          d.count = 1
        })
      ).rejects.toThrow("disk full")
      const shutdown = r.shutdown()
      await failed
      await shutdown
      expect(store).toHaveBeenCalledOnce()
    })

    it("attempts backend close even when draining and flush fail", async () => {
      const backend = new MemoryBackend()
      const r = repo(backend)
      const handle = await r.create<Doc>({ count: 0 })
      vi.spyOn(backend, "store").mockRejectedValue(new Error("store failed"))
      vi.spyOn(backend, "flush").mockRejectedValue(new Error("flush failed"))
      const close = vi.spyOn(backend, "close")
      await expect(
        handle.change(d => {
          d.count = 1
        })
      ).rejects.toThrow("store failed")
      await r.shutdown()
      expect(close).toHaveBeenCalledOnce()
    })

    it("waits for an accepted flush", async () => {
      const backend = new MemoryBackend()
      const blocked = gate()
      const r = repo(backend)
      await r.create<Doc>({ count: 0 })
      vi.spyOn(backend, "flush").mockImplementationOnce(() => blocked.promise)
      const close = vi.spyOn(backend, "close")
      const flushing = r.flush()
      const shutdown = r.shutdown()
      await Promise.resolve()
      expect(close).not.toHaveBeenCalled()
      blocked.resolve()
      await flushing
      await shutdown
      expect(close).toHaveBeenCalledOnce()
    })

    it("waits for an accepted deletion", async () => {
      const backend = new MemoryBackend()
      const blocked = gate()
      const remove = backend.deleteLocal.bind(backend)
      const r = repo(backend)
      const handle = await r.create<Doc>({ count: 0 })
      const deleted = vi
        .spyOn(backend, "deleteLocal")
        .mockImplementationOnce(async id => {
          await blocked.promise
          return remove(id)
        })
      const close = vi.spyOn(backend, "close")
      const deletion = r.delete(handle.documentId)
      const shutdown = r.shutdown()
      await Promise.resolve()
      expect(close).not.toHaveBeenCalled()
      blocked.resolve()
      await deletion
      await shutdown
      expect(deleted).toHaveBeenCalledOnce()
      expect(close).toHaveBeenCalledOnce()
    })
  })
})

async function backendDoc(
  backend: MemoryBackend,
  handle: DocHandle<any>
): Promise<unknown> {
  const session = backend.open(treeId(handle))
  let loaded = A.init<any>()
  let found = false
  try {
    for await (const event of session.events) {
      if (event.type === "records") {
        found = true
        loaded = applyRecords(loaded, event.records)
      }
      if (event.type === "local-load-complete") break
    }
  } finally {
    await session.close()
  }
  return found ? loaded : undefined
}
