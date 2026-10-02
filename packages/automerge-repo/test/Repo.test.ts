import { next as A } from "@automerge/automerge"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Repo } from "../src/Repo.js"
import { DocHandle } from "../src/DocHandle.js"
import {
  binaryToDocumentId,
  documentIdToBinary,
  generateAutomergeUrl,
  encodeHeads,
  parseAutomergeUrl,
  stringifyAutomergeUrl,
} from "../src/AutomergeUrl.js"
import { MemoryBackend } from "../src/sedimentree/testing/MemoryBackend.js"
import { idBytes, sedimentreeId } from "../src/sedimentree/index.js"
import { extractRecords } from "../src/sedimentree/automerge/index.js"
import type { BinaryDocumentId } from "../src/types.js"

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(r => {
    resolve = r
  })
  return { promise, resolve }
}

describe("backend-driven Repo", () => {
  const repos: Repo[] = []
  const releases: (() => void)[] = []
  const repo = (backend?: MemoryBackend) => {
    const result = new Repo({ backend })
    repos.push(result)
    return result
  }
  afterEach(async () => {
    releases.splice(0).forEach(release => release())
    await Promise.all(repos.splice(0).map(r => r.shutdown()))
  })

  it("keeps zero-config creation local and returns full shared DocHandles", async () => {
    const r = repo()
    const creating = r.create({ count: 0 })
    expect(creating).toBeInstanceOf(Promise)
    const handle = await creating
    expect(handle).toBeInstanceOf(DocHandle)
    expect(documentIdToBinary(handle.documentId)).toHaveLength(32)
    expect(await r.find(handle.url)).toBe(handle)
    expect(await r.find(handle.documentId)).toBe(handle)
    expect(r.handles[handle.documentId]).toBe(handle)
    expect(handle.doc()).toEqual({ count: 0 })
    expect((await r.create()).doc()).toEqual({})
    await expect(r.find(generateAutomergeUrl())).rejects.toThrow("unavailable")
  })

  it("preserves change options, event payloads, scoped handles and fixed views", async () => {
    const r = repo(new MemoryBackend())
    const handle = await r.create({ count: 0, nested: { value: 1 } })
    const old = handle.view(handle.heads())
    const sub = handle.sub("nested", "value")
    const changed = vi.fn()
    sub.on("change", changed)
    const saving = sub.change(2, { message: "edit", time: 0 })
    expect(saving).toBeInstanceOf(Promise)
    expect(sub.doc()).toBe(2)
    expect(changed).toHaveBeenCalledWith(
      expect.objectContaining({ handle: sub, doc: 2 })
    )
    expect(old.doc()).toEqual({ count: 0, nested: { value: 1 } })
    await saving
    expect(await r.find(sub.url)).toBe(sub)
    expect(await r.find(old.url)).toBe(old)
    expect(handle.metadata()?.message).toBe("edit")
    expect(handle.history()).toHaveLength(2)
  })

  it("applies edits immediately but waits for local recoverability", async () => {
    const backend = new MemoryBackend()
    const r = repo(backend)
    const handle = await r.create({ count: 0 })
    const blocked = gate(),
      started = gate()
    releases.push(blocked.resolve)
    const store = backend.store.bind(backend)
    vi.spyOn(backend, "store").mockImplementation(async (id, records) => {
      started.resolve()
      await blocked.promise
      await store(id, records)
    })
    let settled = false
    const saved = handle.change(doc => {
      doc.count = 1
    })
    void saved.then(() => {
      settled = true
    })
    expect(handle.doc()).toEqual({ count: 1 })
    await started.promise
    expect(settled).toBe(false)
    const flushing = r.flush()
    blocked.resolve()
    await Promise.all([saved, flushing])
    expect(settled).toBe(true)
  })

  it("retains ambiguous failures and retries original bytes through flush", async () => {
    const backend = new MemoryBackend()
    const r = repo(backend)
    const handle = await r.create({ count: 0 })
    const store = backend.store.bind(backend)
    const attempted: Uint8Array[] = []
    let fail = true
    vi.spyOn(backend, "store").mockImplementation(async (id, records) => {
      attempted.push(records[0].blob.slice())
      await store(id, records)
      if (fail) {
        fail = false
        throw new Error("saved but receipt lost")
      }
    })
    await expect(
      handle.change(doc => {
        doc.count = 1
      })
    ).rejects.toThrow("receipt lost")
    expect(handle.doc()).toEqual({ count: 1 })
    await r.flush()
    expect(attempted).toHaveLength(2)
    expect(attempted[1]).toEqual(attempted[0])
    await r.flush()
    expect(attempted).toHaveLength(2)
  })

  it("flush rejects remaining failures; shutdown still attempts every cleanup", async () => {
    const backend = new MemoryBackend()
    const r = repo(backend)
    const handle = await r.create({ count: 0 })
    vi.spyOn(backend, "store").mockRejectedValue(new Error("disk unavailable"))
    const close = vi.spyOn(backend, "close")
    await expect(
      handle.change(doc => {
        doc.count++
      })
    ).rejects.toThrow("disk unavailable")
    await expect(r.flush()).rejects.toThrow("Repo flush failed")
    await expect(r.shutdown()).resolves.toBeUndefined()
    expect(close).toHaveBeenCalledTimes(1)
    expect(handle.doc()).toEqual({ count: 1 })
    expect(() =>
      handle.change(doc => {
        doc.count++
      })
    ).toThrow("closed")
    await expect(r.create()).rejects.toThrow("shut down")
    expect(r.shutdown()).toBe(r.shutdown())
  })

  it("awaits backend creation without promising remote delivery", async () => {
    const backend = new MemoryBackend()
    const r = repo(backend)
    const blocked = gate(),
      created = gate()
    releases.push(blocked.resolve)
    const create = backend.create.bind(backend)
    vi.spyOn(backend, "create").mockImplementation(async records => {
      created.resolve()
      await blocked.promise
      return create(records)
    })
    let settled = false
    const creating = r.create({ count: 0 })
    void creating.then(() => {
      settled = true
    })
    await created.promise
    expect(settled).toBe(false)
    blocked.resolve()
    const handle = await creating
    expect(handle.doc()).toEqual({ count: 0 })
  })

  it("adopts a lookup that starts while backend creation is pending", async () => {
    const backend = new MemoryBackend()
    const r = repo(backend)
    const blocked = gate(),
      stored = gate()
    releases.push(blocked.resolve)
    const create = backend.create.bind(backend)
    let documentId!: ReturnType<typeof binaryToDocumentId>
    vi.spyOn(backend, "create").mockImplementation(async records => {
      const id = await create(records)
      documentId = binaryToDocumentId(idBytes(id) as BinaryDocumentId)
      stored.resolve()
      await blocked.promise
      return id
    })
    const creating = r.create({ count: 1 })
    await stored.promise
    const finding = r.find(documentId)
    const loaded = await finding
    blocked.resolve()
    expect(await creating).toBe(loaded)
    expect(loaded.doc()).toEqual({ count: 1 })
  })

  it("drains pending creation at shutdown without late handle registration", async () => {
    const backend = new MemoryBackend()
    const r = repo(backend)
    const blocked = gate(),
      started = gate()
    releases.push(blocked.resolve)
    const create = backend.create.bind(backend)
    vi.spyOn(backend, "create").mockImplementation(async records => {
      started.resolve()
      await blocked.promise
      return create(records)
    })
    const creating = r.create({ count: 0 })
    const rejected = expect(creating).rejects.toThrow("shut down")
    await started.promise
    const closing = r.shutdown()
    blocked.resolve()
    await Promise.all([closing, rejected])
    expect(r.handles).toEqual({})
  })

  it("imports supplied IDs, merges existing history, and preserves handle identity", async () => {
    const r = repo(new MemoryBackend())
    const { documentId } = parseAutomergeUrl(generateAutomergeUrl())
    const handle = await r.import<{
      count: number
      left?: number
      right?: number
    }>(A.save(A.from({ count: 0 })), { docId: documentId })
    expect(handle.documentId).toBe(documentId)
    const fork = A.change(A.clone(handle.fullDoc()), doc => {
      doc.right = 2
    })
    await handle.change(doc => {
      doc.left = 1
    })
    expect(await r.import(A.save(fork), { docId: documentId })).toBe(handle)
    expect(handle.doc()).toEqual({ count: 0, left: 1, right: 2 })
    const exported = await r.export(handle.url)
    expect(A.load(exported!)).toEqual(handle.doc())
    const cloned = await r.clone(handle)
    expect(cloned.documentId).not.toBe(handle.documentId)
    expect(cloned.heads()).toEqual(handle.heads())
    await r.flush()
  })

  it("imports into an uncached stored document without replacing its history", async () => {
    const r = repo(new MemoryBackend())
    const handle = await r.create<{
      count: number
      left?: number
      right?: number
    }>({ count: 0 })
    const fork = A.change(A.clone(handle.fullDoc()), doc => {
      doc.right = 2
    })
    await handle.change(doc => {
      doc.left = 1
    })
    await r.removeFromCache(handle.documentId)
    expect(() =>
      handle.change(doc => {
        doc.count++
      })
    ).toThrow("closed")
    const imported = await r.import(A.save(fork), { docId: handle.documentId })
    expect(imported).not.toBe(handle)
    expect(imported.doc()).toEqual({ count: 0, left: 1, right: 2 })
  })

  it("deletes a generation and permits explicit ID reuse", async () => {
    const r = repo(new MemoryBackend())
    const handle = await r.create({ count: 0 })
    const sub = handle.sub("count")
    const deleted = vi.fn()
    sub.on("delete", deleted)
    await r.delete(handle.url)
    expect(handle.isDeleted()).toBe(true)
    expect(deleted).toHaveBeenCalledTimes(1)
    expect(r.findWithProgress(handle.url).peek().state).toBe("loading")
    const imported = await r.import(A.save(A.from({ count: 10 })), {
      docId: handle.documentId,
    })
    expect(imported).not.toBe(handle)
    expect(imported.doc()).toEqual({ count: 10 })
    expect(
      sedimentreeId(documentIdToBinary(imported.documentId)!)
    ).toBeDefined()
  })

  it("shutdown cannot overtake an already accepted deletion", async () => {
    const backend = new MemoryBackend()
    const r = repo(backend)
    const handle = await r.create({ count: 0 })
    const remove = vi.spyOn(backend, "deleteLocal")
    const deleting = r.delete(handle.url)
    expect(() =>
      handle.change(doc => {
        doc.count++
      })
    ).toThrow("deleted")
    await Promise.all([deleting, r.shutdown()])
    expect(remove).toHaveBeenCalledTimes(1)
    expect(handle.isDeleted()).toBe(true)
  })

  it("deletion listeners cannot prevent backend deletion or teardown", async () => {
    const backend = new MemoryBackend()
    const r = repo(backend)
    const handle = await r.create({ count: 0 })
    const remove = vi.spyOn(backend, "deleteLocal")
    handle.on("delete", () => {
      void r.shutdown()
      throw new Error("listener failed")
    })
    await expect(r.delete(handle.url)).resolves.toBeUndefined()
    await r.shutdown()
    expect(remove).toHaveBeenCalledTimes(1)
  })

  it("backend-observed deletion unregisters the old generation", async () => {
    const backend = new MemoryBackend()
    const r = repo(backend)
    const handle = await r.create({ count: 0 })
    await backend.deleteLocal(
      sedimentreeId(documentIdToBinary(handle.documentId)!)
    )
    await vi.waitFor(() => expect(handle.isDeleted()).toBe(true))
    expect(r.handles[handle.documentId]).toBeUndefined()
    const imported = await r.import(A.save(A.from({ count: 2 })), {
      docId: handle.documentId,
    })
    expect(imported).not.toBe(handle)
    expect(imported.doc()).toEqual({ count: 2 })
  })

  it("backend deletion listeners cannot acquire the invalidated handle", async () => {
    const backend = new MemoryBackend()
    const r = repo(backend)
    const handle = await r.create({ count: 0 })
    let finding: Promise<unknown> | undefined
    let rejected: Promise<unknown> | undefined
    handle.on("delete", () => {
      const controller = new AbortController()
      finding = r.find(handle.documentId, { signal: controller.signal })
      rejected = expect(finding).rejects.toBe("cancelled")
      controller.abort("cancelled")
    })
    await backend.deleteLocal(
      sedimentreeId(documentIdToBinary(handle.documentId)!)
    )
    await vi.waitFor(() => expect(finding).toBeDefined())
    await rejected
  })

  it.each(["shutdown", "delete", "removeFromCache"] as const)(
    "%s rejects pending fixed-head lookups and releases listeners",
    async operation => {
      const r = repo(new MemoryBackend())
      const handle = await r.create({ count: 0 })
      const fork = A.change(A.clone(handle.fullDoc()), doc => {
        doc.count = 2
      })
      const url = stringifyAutomergeUrl({
        documentId: handle.documentId,
        heads: encodeHeads(A.getHeads(fork)),
      })
      const baseline = handle.listenerCount("heads-changed")
      const finding = r.find(url)
      const rejected = expect(finding).rejects.toThrow()
      await Promise.resolve()
      if (operation === "shutdown") await r.shutdown()
      else if (operation === "delete") await r.delete(handle.url)
      else await r.removeFromCache(handle.documentId)
      await rejected
      expect(handle.listenerCount("heads-changed")).toBe(baseline)
    }
  )

  it("throwing progress subscribers cannot interrupt shutdown", async () => {
    const backend = new MemoryBackend()
    const r = repo(backend)
    const close = vi.spyOn(backend, "close")
    const progress = r.findWithProgress(generateAutomergeUrl())
    progress.subscribe(() => {
      throw new Error("subscriber failed")
    })
    const finding = progress.whenReady()
    const rejected = expect(finding).rejects.toThrow("shut down")
    await expect(r.shutdown()).resolves.toBeUndefined()
    await rejected
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("aborts only one caller's wait and retains progress during loading", async () => {
    const backend = new MemoryBackend()
    const r = repo(backend)
    const synchronize = gate()
    releases.push(synchronize.resolve)
    const open = backend.open.bind(backend)
    vi.spyOn(backend, "open").mockImplementation(id => {
      const session = open(id)
      const sync = session.synchronize.bind(session)
      session.synchronize = async () => {
        await synchronize.promise
        return sync()
      }
      return session
    })
    const url = generateAutomergeUrl()
    const controller = new AbortController()
    const one = r.find(url, { signal: controller.signal })
    const rejected = expect(one).rejects.toBe("cancelled")
    const two = r.find(url)
    const stillWaiting = vi.fn()
    void two.then(stillWaiting, stillWaiting)
    controller.abort("cancelled")
    await rejected
    expect(r.findWithProgress(url).peek().state).toBe("loading")
    synchronize.resolve()
    expect(stillWaiting).not.toHaveBeenCalled()
    expect(r.findWithProgress(url).peek().state).toBe("loading")
  })

  it("makes an empty lookup unavailable without preventing later history", async () => {
    const backend = new MemoryBackend()
    const r = repo(backend)
    const url = generateAutomergeUrl()
    const { documentId } = parseAutomergeUrl(url)
    const progress = r.findWithProgress<{ count: number }>(url)
    const states: string[] = []
    progress.subscribe(state => states.push(state.state))
    await vi.waitFor(() => expect(progress.peek().state).toBe("unavailable"))
    await backend.store(
      sedimentreeId(documentIdToBinary(documentId)!),
      extractRecords(A.from({ count: 3 }))
    )
    await vi.waitFor(() => expect(progress.peek().state).toBe("ready"))
    expect((await r.find<{ count: number }>(url)).doc()).toEqual({ count: 3 })
    expect(states).toContain("unavailable")
    expect(states).not.toContain("failed")
  })

  it("reports open errors as source unavailability, not document failure", async () => {
    const backend = new MemoryBackend()
    vi.spyOn(backend, "open").mockImplementation(() => {
      throw new Error("open failed")
    })
    const r = repo(backend)
    const progress = r.findWithProgress(generateAutomergeUrl())
    expect(progress.peek().state).toBe("unavailable")
    expect(progress.peek().sources.backend).toBe("unavailable")
    expect(progress.peek().state).not.toBe("failed")
  })
})
