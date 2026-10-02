import { next as A } from "@automerge/automerge"
import { describe, expect, it, vi, type Mock } from "vitest"
import { Document } from "../src/Document.js"
import { DocHandle } from "../src/DocHandle.js"
import { DocumentQuery } from "../src/DocumentQuery.js"
import { DocumentDelegate } from "../src/DocumentDelegate.js"
import { RepoScheduler } from "../src/RepoScheduler.js"
import { MemoryBackend } from "../src/sedimentree/testing/MemoryBackend.js"
import {
  sedimentreeId,
  type SedimentreeId,
  type SedimentreeSession,
} from "../src/sedimentree/index.js"
import {
  applyRecords,
  extractRecords,
} from "../src/sedimentree/automerge/index.js"
import type { DocumentId } from "../src/types.js"

const id = (n: number) => sedimentreeId(n.toString(16).padStart(32, "0"))
const records = () => extractRecords(A.from({ count: 1 }))
function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(r => {
    resolve = r
  })
  return { promise, resolve }
}
function attach(scheduler: RepoScheduler, documentId = id(1), open = true) {
  const document = new Document(
    documentId as unknown as DocumentId,
    A.from({ count: 0 })
  )
  const handle = new DocHandle(document)
  const query = new DocumentQuery(handle)
  const delegate: DocumentDelegate<{ count: number }> = new DocumentDelegate(
    documentId,
    document,
    query,
    (id, records) => scheduler.submit(id, records),
    () => scheduler.synchronize(delegate)
  )
  delegate.attach(handle, true)
  if (open) scheduler.open(delegate)
  return { delegate, document, handle, query }
}

describe("RepoScheduler", () => {
  it("bounds cross-document concurrency without global head-of-line blocking", async () => {
    const backend = new MemoryBackend()
    const blocked = gate()
    const starts: SedimentreeId[] = []
    const store = backend.store.bind(backend)
    vi.spyOn(backend, "store").mockImplementation(async (documentId, batch) => {
      starts.push(documentId)
      if (documentId === id(1)) await blocked.promise
      await store(documentId, batch)
    })
    const scheduler = new RepoScheduler(backend, { concurrency: 2 })
    const first = scheduler.submit(id(1), records())
    const same = scheduler.submit(id(1), records())
    const second = scheduler.submit(id(2), records())
    await second
    expect(starts).toEqual([id(1), id(2)])
    blocked.resolve()
    await Promise.all([first, same])
    expect(starts).toEqual([id(1), id(2), id(1)])
    await scheduler.close()
  })

  it("snapshots queued bytes synchronously", async () => {
    const backend = new MemoryBackend()
    const store = vi.spyOn(backend, "store")
    const scheduler = new RepoScheduler(backend)
    const batch = records()
    const bytes = batch[0].blob.slice()
    const write = scheduler.submit(id(1), batch)
    batch[0].blob.fill(0)
    await write
    expect(store.mock.calls[0][1][0].blob).toEqual(bytes)
    await scheduler.close()
  })

  it("flush(ids) drains only captured target writes, including queued jobs", async () => {
    const backend = new MemoryBackend()
    const blocked = gate()
    const store = backend.store.bind(backend)
    vi.spyOn(backend, "store").mockImplementation(async (documentId, batch) => {
      if (documentId === id(2)) await blocked.promise
      await store(documentId, batch)
    })
    const flush = vi.spyOn(backend, "flush")
    const scheduler = new RepoScheduler(backend)
    const first = scheduler.submit(id(1), records())
    const second = scheduler.submit(id(2), records())
    await scheduler.flush([id(1)])
    expect(flush).toHaveBeenCalledWith([id(1)])
    await first
    blocked.resolve()
    await second
    await scheduler.close()
  })

  it("reopens a rescan into the same document without losing edits", async () => {
    const backend = new MemoryBackend()
    const originalOpen = backend.open.bind(backend)
    let count = 0
    vi.spyOn(backend, "open").mockImplementation(documentId => {
      if (++count > 1) return originalOpen(documentId)
      const session = originalOpen(documentId)
      return {
        ...session,
        events: (async function* () {
          yield { type: "rescan-required" as const, sequence: 0 }
        })(),
        close: () => session.close(),
        synchronize: options => session.synchronize(options),
        publishEphemeral: message => session.publishEphemeral(message),
      } satisfies SedimentreeSession
    })
    const scheduler = new RepoScheduler(backend)
    const { handle, document } = attach(scheduler)
    await handle.change(d => {
      d.count = 7
    })
    await vi.waitFor(() => expect(count).toBe(2))
    expect(handle.doc()?.count).toBe(7)
    expect(document.doc.count).toBe(7)
    await scheduler.close()
  })

  it("flush succeeds when a captured delegate store fails but its retry persists", async () => {
    const backend = new MemoryBackend()
    vi.spyOn(backend, "store").mockRejectedValueOnce(
      new Error("temporary failure")
    )
    const scheduler = new RepoScheduler(backend)
    const { handle } = attach(scheduler)
    const write = handle.change(d => {
      d.count = 1
    })
    const failed = expect(write).rejects.toThrow("temporary failure")
    const flush = scheduler.flush()
    await failed
    await flush
    await scheduler.close()
  })

  it("flush still surfaces captured creation and unowned store failures", async () => {
    const backend = new MemoryBackend()
    vi.spyOn(backend, "create").mockRejectedValueOnce(
      new Error("create failed")
    )
    const scheduler = new RepoScheduler(backend)
    attach(scheduler)
    const creation = scheduler.create(records(), { documentId: id(1) })
    const rejected = expect(creation).rejects.toThrow("create failed")
    const flush = scheduler.flush()
    await rejected
    await expect(flush).rejects.toThrow("Repo flush failed")
    vi.spyOn(backend, "store").mockRejectedValueOnce(
      new Error("raw store failed")
    )
    const raw = scheduler.submit(id(1), records())
    const rawRejected = expect(raw).rejects.toThrow("raw store failed")
    const rawFlush = scheduler.flush()
    await rawRejected
    await expect(rawFlush).rejects.toThrow("Repo flush failed")
    await scheduler.close()
  })

  it("captures backend flush synchronously before later edits", async () => {
    const backend = new MemoryBackend()
    const pending: Promise<void>[] = []
    const barriers: Promise<void>[][] = []
    vi.spyOn(backend, "flush").mockImplementation(() => {
      const captured = [...pending]
      barriers.push(captured)
      return Promise.all(captured).then(() => {})
    })
    const scheduler = new RepoScheduler(backend)
    const { handle } = attach(scheduler)
    const first = gate()
    pending.push(first.promise)
    const flush = scheduler.flush()
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
    await scheduler.close()
  })

  it("detach drains writes and closes interest without deleting history", async () => {
    const backend = new MemoryBackend()
    const store = backend.store.bind(backend)
    const blocked = gate()
    vi.spyOn(backend, "store").mockImplementation(
      async (documentId, records) => {
        await blocked.promise
        await store(documentId, records)
      }
    )
    const deleted = vi.spyOn(backend, "deleteLocal")
    const scheduler = new RepoScheduler(backend)
    const { delegate, handle } = attach(scheduler)
    await store(id(1), extractRecords(handle.fullDoc()))
    const write = handle.change(d => {
      d.count = 9
    })
    const detached = scheduler.detach(delegate)
    expect(() =>
      handle.change(d => {
        d.count = 10
      })
    ).toThrow("closed")
    expect(scheduler.detach(delegate)).toBe(detached)
    blocked.resolve()
    await write
    await detached
    expect(deleted).not.toHaveBeenCalled()
    expect(handle.isDeleted()).toBe(false)
    await expect(scheduler.synchronize(delegate)).rejects.toThrow(
      "No active session"
    )
    const session = backend.open(id(1))
    let loaded = A.init<{ count: number }>()
    for await (const event of session.events) {
      if (event.type === "records") loaded = applyRecords(loaded, event.records)
      if (event.type === "local-load-complete") break
    }
    expect(loaded.count).toBe(9)
    await session.close()
    await scheduler.close()
  })

  it("retains ownership and failed batches when detach cannot drain", async () => {
    const backend = new MemoryBackend()
    const store = backend.store.bind(backend)
    const attempts = vi
      .spyOn(backend, "store")
      .mockRejectedValue(new Error("disk full"))
    const scheduler = new RepoScheduler(backend)
    const { delegate, handle } = attach(scheduler)
    await expect(
      handle.change(d => {
        d.count = 1
      })
    ).rejects.toThrow("disk full")
    await expect(scheduler.detach(delegate)).rejects.toThrow(
      "Repo flush failed"
    )
    attempts.mockImplementation(store)
    await scheduler.detach(delegate)
    expect(attempts).toHaveBeenCalledTimes(3)
    await scheduler.close()
  })

  it("detach also drains an unobserved delegate without creating a session", async () => {
    const backend = new MemoryBackend()
    const store = backend.store.bind(backend)
    const attempts = vi
      .spyOn(backend, "store")
      .mockRejectedValueOnce(new Error("disk full"))
    const open = vi.spyOn(backend, "open")
    const scheduler = new RepoScheduler(backend)
    const { delegate, handle } = attach(scheduler, id(1), false)
    await store(id(1), extractRecords(handle.fullDoc()))
    await expect(
      handle.change(d => {
        d.count = 4
      })
    ).rejects.toThrow("disk full")
    await scheduler.detach(delegate)
    expect(attempts).toHaveBeenCalledTimes(2)
    expect(open).not.toHaveBeenCalled()
    await scheduler.close()
  })

  it("detach retains a session whose close failed, so cleanup can be retried", async () => {
    const backend = new MemoryBackend()
    const open = backend.open.bind(backend)
    let close!: Mock<() => Promise<void>>
    vi.spyOn(backend, "open").mockImplementation(documentId => {
      const session = open(documentId)
      close = vi
        .fn(() => session.close())
        .mockRejectedValueOnce(new Error("close failed"))
      return {
        events: session.events,
        close,
        synchronize: options => session.synchronize(options),
        publishEphemeral: message => session.publishEphemeral(message),
      }
    })
    const scheduler = new RepoScheduler(backend)
    const { delegate } = attach(scheduler)
    await expect(scheduler.detach(delegate)).rejects.toThrow("close failed")
    await scheduler.detach(delegate)
    expect(close).toHaveBeenCalledTimes(2)
    await scheduler.close()
  })

  it("does not hide opaque backend flush failures after store recovery", async () => {
    const backend = new MemoryBackend()
    vi.spyOn(backend, "store").mockRejectedValueOnce(new Error("store failed"))
    vi.spyOn(backend, "flush").mockRejectedValueOnce(
      new Error("barrier failed")
    )
    const scheduler = new RepoScheduler(backend)
    const { handle } = attach(scheduler)
    const rejected = expect(
      handle.change(d => {
        d.count = 1
      })
    ).rejects.toThrow("store failed")
    const flush = scheduler.flush()
    await rejected
    await expect(flush).rejects.toThrow("Repo flush failed")
    await scheduler.close()
  })

  it("delete stops producers, drains earlier work, rejects writes during barrier", async () => {
    const backend = new MemoryBackend()
    const blocked = gate()
    const store = backend.store.bind(backend)
    vi.spyOn(backend, "store").mockImplementation(async (documentId, batch) => {
      await blocked.promise
      await store(documentId, batch)
    })
    const deleted = vi.spyOn(backend, "deleteLocal")
    const scheduler = new RepoScheduler(backend)
    const { delegate, handle } = attach(scheduler)
    const write = handle.change(d => {
      d.count = 1
    })
    const deletion = scheduler.delete(delegate)
    await expect(scheduler.submit(id(1), records())).rejects.toThrow("deletion")
    expect(() =>
      handle.change(d => {
        d.count = 2
      })
    ).toThrow("deleted")
    expect(deleted).not.toHaveBeenCalled()
    blocked.resolve()
    await write
    await deletion
    expect(deleted).toHaveBeenCalledOnce()
    await scheduler.close()
  })

  it("fences submissions from reentrant delete listeners", async () => {
    const backend = new MemoryBackend()
    const scheduler = new RepoScheduler(backend)
    const { handle, delegate } = attach(scheduler)
    let reentrant!: Promise<void>
    handle.on("delete", () => {
      reentrant = scheduler.submit(id(1), records())
    })
    const deletion = scheduler.delete(delegate)
    await expect(reentrant).rejects.toThrow("deletion")
    await deletion
    await scheduler.close()
  })

  it("rejects queued old-generation stores after an observed deletion", async () => {
    const backend = new MemoryBackend()
    const blocked = gate()
    const store = backend.store.bind(backend)
    const storedIds: SedimentreeId[] = []
    vi.spyOn(backend, "store").mockImplementation(async (documentId, batch) => {
      storedIds.push(documentId)
      if (documentId === id(2)) await blocked.promise
      await store(documentId, batch)
    })
    const originalOpen = backend.open.bind(backend)
    vi.spyOn(backend, "open").mockImplementation(documentId => {
      const session = originalOpen(documentId)
      return {
        events: (async function* () {
          yield { type: "deleted" as const, sequence: 1 }
        })(),
        close: () => session.close(),
        synchronize: options => session.synchronize(options),
        publishEphemeral: message => session.publishEphemeral(message),
      }
    })
    const scheduler = new RepoScheduler(backend, { concurrency: 1 })
    const other = scheduler.submit(id(2), records())
    const stale = scheduler.submit(id(1), records())
    const rejection = expect(stale).rejects.toThrow("generation deleted")
    const { handle } = attach(scheduler)
    await vi.waitFor(() => expect(handle.isDeleted()).toBe(true))
    blocked.resolve()
    await other
    await rejection
    expect(storedIds).toEqual([id(2)])
    await scheduler.close()
  })

  it("orders explicit-ID creation before submissions for that ID", async () => {
    const backend = new MemoryBackend()
    const blocked = gate()
    const create = backend.create.bind(backend)
    vi.spyOn(backend, "create").mockImplementation(async (batch, options) => {
      await blocked.promise
      return create(batch, options)
    })
    const store = vi.spyOn(backend, "store")
    const scheduler = new RepoScheduler(backend)
    const creation = scheduler.create(records(), { documentId: id(1) })
    const write = scheduler.submit(id(1), records())
    await Promise.resolve()
    expect(store).not.toHaveBeenCalled()
    blocked.resolve()
    await creation
    await write
    expect(store).toHaveBeenCalledTimes(2)
    await scheduler.close()
  })

  it("shutdown drains pending creation and rejects new work immediately", async () => {
    const backend = new MemoryBackend()
    const blocked = gate()
    const create = backend.create.bind(backend)
    vi.spyOn(backend, "create").mockImplementation(async (batch, options) => {
      await blocked.promise
      return create(batch, options)
    })
    const close = vi.spyOn(backend, "close")
    const scheduler = new RepoScheduler(backend)
    const creation = scheduler.create(records())
    const shutdown = scheduler.shutdown()
    expect(scheduler.close()).toBe(shutdown)
    await expect(scheduler.submit(id(2), records())).rejects.toThrow("closed")
    expect(close).not.toHaveBeenCalled()
    blocked.resolve()
    await creation
    await shutdown
    expect(close).toHaveBeenCalledOnce()
  })

  it("shutdown retries retained writes after closing document producers", async () => {
    const backend = new MemoryBackend()
    const store = backend.store.bind(backend)
    const attempts = vi
      .spyOn(backend, "store")
      .mockRejectedValueOnce(new Error("disk full"))
    attempts.mockImplementationOnce(async (id, batch) => store(id, batch))
    const scheduler = new RepoScheduler(backend)
    const { handle } = attach(scheduler)
    await expect(
      handle.change(d => {
        d.count = 1
      })
    ).rejects.toThrow("disk full")
    await scheduler.shutdown()
    expect(attempts).toHaveBeenCalledTimes(2)
  })

  it("shutdown recovers a store attempt captured while still pending", async () => {
    const backend = new MemoryBackend()
    vi.spyOn(backend, "store").mockRejectedValueOnce(new Error("disk full"))
    const scheduler = new RepoScheduler(backend)
    const { handle } = attach(scheduler)
    const failed = expect(
      handle.change(d => {
        d.count = 1
      })
    ).rejects.toThrow("disk full")
    const shutdown = scheduler.shutdown()
    await failed
    await shutdown
  })

  it("attempts backend close even when draining and flush fail", async () => {
    const backend = new MemoryBackend()
    vi.spyOn(backend, "store").mockRejectedValue(new Error("store failed"))
    vi.spyOn(backend, "flush").mockRejectedValue(new Error("flush failed"))
    const close = vi.spyOn(backend, "close")
    const scheduler = new RepoScheduler(backend)
    const { handle } = attach(scheduler)
    await expect(
      handle.change(d => {
        d.count = 1
      })
    ).rejects.toThrow("store failed")
    await expect(scheduler.shutdown()).rejects.toThrow("Repo shutdown failed")
    expect(close).toHaveBeenCalledOnce()
  })
})
