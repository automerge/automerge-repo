import { next as A } from "@automerge/automerge"
import * as slim from "@automerge/automerge/slim"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Repo } from "../src/Repo.js"
import type { DocHandle } from "../src/DocHandle.js"
import { MemoryBackend } from "./helpers/MemoryBackend.js"
import { sedimentreeId, type RecordBatch } from "../src/sedimentree/index.js"
import { extractNewCommits } from "../src/sedimentree/automerge/index.js"
import { documentIdToBinary } from "../src/AutomergeUrl.js"

// Native ESM exports are sealed; forward through a configurable namespace so
// the library's slim import can be spied on.
vi.mock("@automerge/automerge/slim", async importOriginal => ({
  ...(await importOriginal<typeof import("@automerge/automerge/slim")>()),
}))

type Doc = { count: number }

// Repo assigns each document a random actor, so change hashes, and where
// boundaries fall, differ per run. Fixtures therefore stop at any boundary
// level, and assertions tolerate a higher boundary absorbing an earlier one.
const create = (r: Repo) => r.create<Doc>({ count: 0 })

/** Edit until the latest change is a fragment boundary (hash `00…`). */
async function editToBoundary(handle: DocHandle<Doc>): Promise<string> {
  for (let i = 0; i < 20_000; i++) {
    await handle.change(d => {
      d.count++
    })
    const [head] = A.getHeads(handle.fullDoc())
    if (head.startsWith("00")) return head
  }
  throw new Error("No boundary commit")
}

/** Changes on a clone up to and including the next boundary. */
function forkToBoundary(doc: A.Doc<Doc>, minimumChanges = 1): A.Doc<Doc> {
  let fork = A.clone(doc)
  for (let i = 1; ; i++) {
    fork = A.change(fork, d => {
      d.count++
    })
    if (A.getHeads(fork)[0].startsWith("00") && i >= minimumChanges) return fork
  }
}

function stored(store: { mock: { calls: [unknown, RecordBatch][] } }) {
  return store.mock.calls.flatMap(([, batch]) => batch)
}
const fragmentHeads = (store: Parameters<typeof stored>[0]) =>
  stored(store).flatMap(r => (r.kind === "fragment" ? [r.head] : []))

describe("Repo compaction", () => {
  const repos: Repo[] = []
  const repo = (backend: MemoryBackend) => {
    const result = new Repo({ backend })
    repos.push(result)
    return result
  }
  afterEach(async () => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    await Promise.all(repos.splice(0).map(r => r.shutdown()))
    vi.restoreAllMocks()
  })

  it("stores edits as loose commits and compacts a boundary after a jittered delay", async () => {
    vi.useFakeTimers()
    const backend = new MemoryBackend()
    const r = repo(backend)
    const handle = await create(r)
    const store = vi.spyOn(backend, "store")
    const head = await editToBoundary(handle)
    expect(stored(store).every(record => record.kind === "commit")).toBe(true)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(fragmentHeads(store)).toEqual([])
    await vi.advanceTimersByTimeAsync(2_002)
    expect(fragmentHeads(store)).toEqual([head])
  })

  it("compacts a burst of boundaries in one store, once", async () => {
    vi.useFakeTimers()
    const backend = new MemoryBackend()
    const r = repo(backend)
    const handle = await create(r)
    const store = vi.spyOn(backend, "store")
    const first = await editToBoundary(handle)
    const second = await editToBoundary(handle)
    await vi.advanceTimersByTimeAsync(12_001)
    const batches = store.mock.calls.filter(([, batch]) =>
      batch.some(record => record.kind === "fragment")
    )
    expect(batches).toHaveLength(1)
    // A higher-level second boundary absorbs the first; otherwise both are stored.
    const heads = fragmentHeads(store)
    expect(heads).toContain(second)
    expect(heads.every(head => head === first || head === second)).toBe(true)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(
      store.mock.calls.filter(([, batch]) =>
        batch.some(record => record.kind === "fragment")
      )
    ).toHaveLength(1)
  })

  it("waits for an idle moment once the timer fires", async () => {
    vi.useFakeTimers()
    const idle: { run: () => void; options?: { timeout: number } }[] = []
    vi.stubGlobal(
      "requestIdleCallback",
      (run: () => void, options?: { timeout: number }) =>
        idle.push({ run, options })
    )
    vi.stubGlobal("cancelIdleCallback", () => {})
    const backend = new MemoryBackend()
    const r = repo(backend)
    const handle = await create(r)
    const store = vi.spyOn(backend, "store")
    const head = await editToBoundary(handle)
    await vi.advanceTimersByTimeAsync(12_001)
    expect(idle).toHaveLength(1)
    expect(idle[0].options).toEqual({ timeout: 10_000 })
    expect(fragmentHeads(store)).toEqual([])
    idle[0].run()
    await vi.waitFor(() => expect(fragmentHeads(store)).toEqual([head]))
  })

  it("spreads documents that become due together", async () => {
    vi.useFakeTimers()
    const random = vi.spyOn(Math, "random")
    const backend = new MemoryBackend()
    const r = repo(backend)
    const a = await create(r)
    const b = await create(r)
    const store = vi.spyOn(backend, "store")
    random.mockReturnValue(0)
    const early = await editToBoundary(a)
    random.mockReturnValue(0.99)
    const late = await editToBoundary(b)
    await vi.advanceTimersByTimeAsync(10_500)
    expect(fragmentHeads(store)).toEqual([early])
    await vi.advanceTimersByTimeAsync(1_600)
    expect(fragmentHeads(store)).toEqual([early, late])
  })

  it("flush compacts what is due, including after the document closes", async () => {
    const backend = new MemoryBackend()
    const r = repo(backend)
    const handle = await create(r)
    const store = vi.spyOn(backend, "store")
    const head = await editToBoundary(handle)
    await r.flush([handle.documentId])
    expect(fragmentHeads(store)).toEqual([head])
    await r.flush()
    expect(fragmentHeads(store)).toEqual([head])

    const next = await editToBoundary(handle)
    await r.removeFromCache(handle.documentId)
    expect(fragmentHeads(store)).toEqual([head, next])
    const reloaded = await r.find<Doc>(handle.url)
    expect(A.getHeads(reloaded.fullDoc())).toEqual([next])
  })

  it("shutdown compacts what is due", async () => {
    const backend = new MemoryBackend()
    const r = new Repo({ backend })
    const handle = await create(r)
    const store = vi.spyOn(backend, "store")
    const head = await editToBoundary(handle)
    await r.shutdown()
    expect(fragmentHeads(store)).toEqual([head])
  })

  it("compacts a boundary received from a peer", async () => {
    vi.useFakeTimers()
    const backend = new MemoryBackend()
    const r = repo(backend)
    const handle = await create(r)
    // A peer writes loose commits straight to the backend.
    const before = handle.fullDoc()
    const after = forkToBoundary(before)
    const id = sedimentreeId(documentIdToBinary(handle.documentId)!)
    await backend.store(id, extractNewCommits(before, after))
    const store = vi.spyOn(backend, "store")
    await vi.waitFor(() =>
      expect(A.getHeads(handle.fullDoc())).toEqual(A.getHeads(after))
    )
    await vi.advanceTimersByTimeAsync(12_001)
    expect(fragmentHeads(store)).toEqual(A.getHeads(after))
  })

  it("compacts a boundary stored loose before the document loads", async () => {
    // A crash before compaction leaves the boundary loose in storage.
    const backend = new MemoryBackend()
    const writer = repo(backend)
    const handle = await create(writer)
    const before = handle.fullDoc()
    const after = forkToBoundary(before)
    const id = sedimentreeId(documentIdToBinary(handle.documentId)!)
    await backend.store(id, extractNewCommits(before, after))
    const reader = repo(backend)
    const store = vi.spyOn(backend, "store")
    const loaded = await reader.find<Doc>(handle.url)
    expect(A.getHeads(loaded.fullDoc())).toEqual(A.getHeads(after))
    await reader.flush([handle.documentId])
    expect(fragmentHeads(store)).toEqual(A.getHeads(after))
  })

  it("does not rebuild a stored fragment when the document loads", async () => {
    const backend = new MemoryBackend()
    const writer = repo(backend)
    const handle = await create(writer)
    await editToBoundary(handle)
    await writer.flush()
    const reader = repo(backend)
    const store = vi.spyOn(backend, "store")
    await reader.find<Doc>(handle.url)
    await reader.flush()
    expect(store).not.toHaveBeenCalled()
  })

  it("another repo's fragment clears the boundary it covers", async () => {
    vi.useFakeTimers()
    const random = vi.spyOn(Math, "random")
    const backend = new MemoryBackend()
    const writer = repo(backend)
    const reader = repo(backend)
    const handle = await create(writer)
    const remote = await reader.find<Doc>(handle.url)
    const store = vi.spyOn(backend, "store")
    // The writer's timer fires first; the reader's later, after the echo.
    random.mockReturnValueOnce(0).mockReturnValue(0.99)
    const head = await editToBoundary(handle)
    await vi.waitFor(() => expect(A.getHeads(remote.fullDoc())).toEqual([head]))
    await vi.advanceTimersByTimeAsync(12_001)
    expect(fragmentHeads(store)).toEqual([head])
  })

  it("a fragment delivered in the same batch as its boundary covers it", async () => {
    vi.useFakeTimers()
    const backend = new MemoryBackend({ batchRecords: 100_000 })
    const writer = repo(backend)
    const reader = repo(backend)
    const handle = await create(writer)
    const remote = await reader.find<Doc>(handle.url)
    // A merge stores boundary commits and their fragments in one batch, which
    // MemoryBackend delivers to the reader as one event.
    const fork = forkToBoundary(handle.fullDoc())
    const other = await writer.import<Doc>(A.save(fork))
    await handle.merge(other)
    await vi.waitFor(() =>
      expect(A.getHeads(remote.fullDoc())).toEqual(A.getHeads(fork))
    )
    const store = vi.spyOn(backend, "store")
    await vi.advanceTimersByTimeAsync(12_001)
    await reader.flush()
    expect(fragmentHeads(store)).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it("does not poll a boundary whose dependencies are missing", async () => {
    vi.useFakeTimers()
    const backend = new MemoryBackend()
    const r = repo(backend)
    const handle = await create(r)
    const base = handle.fullDoc()
    const fork = forkToBoundary(base, 2)
    const chain = extractNewCommits(base, fork)
    // Deliver the boundary commit without its ancestors.
    const id = sedimentreeId(documentIdToBinary(handle.documentId)!)
    await backend.store(id, [chain.at(-1)!])
    await vi.waitFor(() =>
      expect(A.getMissingDeps(handle.fullDoc())).not.toEqual([])
    )
    const store = vi.spyOn(backend, "store")
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(12_001)
    // Nothing stored, and no timer re-armed to poll the pending head.
    expect(store).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    // The ancestors arrive: the head is retried and compacted.
    await backend.store(id, chain.slice(0, -1))
    await vi.waitFor(() =>
      expect(A.getHeads(handle.fullDoc())).toEqual(A.getHeads(fork))
    )
    await vi.advanceTimersByTimeAsync(12_001)
    expect(fragmentHeads(store)).toEqual(A.getHeads(fork))
  })

  it("does nothing more once a boundary's fragment is stored", async () => {
    const backend = new MemoryBackend()
    const r = repo(backend)
    const handle = await create(r)
    await editToBoundary(handle)
    await r.flush()
    const store = vi.spyOn(backend, "store")
    await r.flush()
    expect(store).not.toHaveBeenCalled()
  })

  it("a failed compaction fails like any write", async () => {
    const backend = new MemoryBackend()
    const r = repo(backend)
    const handle = await create(r)
    await editToBoundary(handle)
    vi.spyOn(backend, "store").mockImplementationOnce(() =>
      Promise.reject(new Error("Disk unavailable"))
    )
    await expect(r.flush()).rejects.toThrow()
    await expect(
      handle.change(d => {
        d.count++
      })
    ).rejects.toThrow("Disk unavailable")
    await expect(r.flush()).rejects.toThrow()
  })

  it("a failure to prepare a merge's records fail-stops the document", async () => {
    const backend = new MemoryBackend()
    const r = repo(backend)
    const handle = await create(r)
    const fork = forkToBoundary(handle.fullDoc())
    const other = await r.import<Doc>(A.save(fork))
    vi.spyOn(slim, "bundleFragmentMetadata").mockImplementationOnce(() => {
      throw new Error("bundle failed")
    })
    await expect(handle.merge(other)).rejects.toThrow("bundle failed")
    // The merged state is visible but unstored: no later write may hide that.
    expect(handle.doc()!.count).toBe(fork.count)
    await expect(
      handle.change(d => {
        d.count++
      })
    ).rejects.toThrow("bundle failed")
    await expect(r.flush()).rejects.toThrow()
  })

  it("a document deleted through its handle compacts nothing further", async () => {
    vi.useFakeTimers()
    const backend = new MemoryBackend()
    const r = repo(backend)
    const handle = await create(r)
    await editToBoundary(handle)
    const store = vi.spyOn(backend, "store")
    handle.delete()
    await r.delete(handle.documentId)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(store).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
