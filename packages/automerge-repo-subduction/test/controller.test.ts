import * as A from "@automerge/automerge"
import { MemorySigner } from "@automerge/subduction"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import {
  commitId,
  idBytes,
  sedimentreeId,
  type LooseCommitRecord,
} from "@automerge/automerge-repo/sedimentree"
import { extractRecords } from "@automerge/automerge-repo/sedimentree/automerge"
import { SedimentreeDocumentController } from "../../automerge-repo/src/SedimentreeDocumentController.js"
import { binaryToDocumentId } from "../../automerge-repo/src/AutomergeUrl.js"
import type { BinaryDocumentId } from "../../automerge-repo/src/types.js"
import { SubductionBackend } from "../src/index.js"
import { DiskStore, deferred } from "./storage.js"
import { fragmentFixture } from "./fragmentFixture.js"

const id = sedimentreeId("57".repeat(16))
const documentId = binaryToDocumentId(idBytes(id) as BinaryDocumentId)
type State = { count: number }
function created() {
  return A.change(A.init<State>({ actor: "aabbcc" }), { time: 0 }, d => {
    d.count = 0
  })
}

describe("Repo's internal document controller with real Subduction", () => {
  let directory: string
  let storage: DiskStore
  let signer: MemorySigner
  const backends: SubductionBackend[] = []
  const controllers: SedimentreeDocumentController<State>[] = []
  function backend() {
    const result = new SubductionBackend({
      signer,
      storage,
      persistence: "persistent",
    })
    backends.push(result)
    return result
  }
  function controller(store: SubductionBackend, initialDoc?: A.Doc<State>) {
    const result = new SedimentreeDocumentController({
      backend: store,
      id,
      documentId,
      initialDoc,
    })
    controllers.push(result)
    return result
  }
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "repo-controller-subduction-"))
    storage = new DiskStore(directory)
    signer = MemorySigner.fromBytes(new Uint8Array(32).fill(42))
  })
  afterEach(async () => {
    await Promise.allSettled(controllers.splice(0).map(c => c.close()))
    for (const b of backends.splice(0)) {
      await b.flush().catch(() => {})
      await b.close().catch(() => {})
    }
    signer.free()
    await rm(directory, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it("persists creation without a later edit, reloads without writeback, and persists a handle edit", async () => {
    const firstBackend = backend()
    const first = controller(firstBackend, created())
    await first.flush()
    await first.close()
    await firstBackend.close()

    const secondBackend = backend()
    const stored = vi.spyOn(secondBackend, "store")
    const second = controller(secondBackend)
    await second.query.whenReady()
    expect(second.handle.doc()).toEqual({ count: 0 })
    expect(second.handle.url).toBe(`automerge:${documentId}`)
    await second.flush()
    expect(stored).not.toHaveBeenCalled()
    // Keep the single-edit fixture deterministic.
    second.handle.update(doc => A.clone(doc, { actor: "ddeeff" }))
    second.handle.change(
      d => {
        d.count = 1
      },
      { time: 0 }
    )
    await second.flush()
    expect(stored).toHaveBeenCalledTimes(1)
    await second.close()
    await secondBackend.close()

    const third = controller(backend())
    await third.query.whenReady()
    expect(third.handle.doc()).toEqual({ count: 1 })
  })

  it.each(["commits", "fragments"])(
    "recovers %s in a fresh process without rewriting loaded history",
    async history => {
      const run = promisify(execFile)
      for (const mode of ["write", "read"]) {
        await run(process.execPath, [
          "--import",
          import.meta.resolve("tsx"),
          new URL("./fresh-process.ts", import.meta.url).pathname,
          mode,
          directory,
          history,
        ])
      }
    },
    20000
  )

  it("persists a fragmented Automerge history, reloads without writeback, and persists further edits", async () => {
    const doc = fragmentFixture()
    const firstBackend = backend()
    const first = controller(firstBackend, doc)
    await first.flush()
    expect(
      (await storage.list("subduction-v1/")).some(k =>
        k.includes("/fragments/")
      )
    ).toBe(true)
    await first.close()
    await firstBackend.close()

    const secondBackend = backend()
    const stored = vi.spyOn(secondBackend, "store")
    const second = controller(secondBackend)
    await second.query.whenReady()
    expect(A.getHeads(second.document.doc)).toEqual(A.getHeads(doc))
    expect(second.handle.doc()).toEqual({ count: 1999 })
    await second.flush()
    expect(stored).not.toHaveBeenCalled()
    second.handle.change(
      d => {
        d.count = 2000
      },
      { time: 0 }
    )
    await second.flush()
    await second.close()
    await secondBackend.close()
    const third = controller(backend())
    await third.query.whenReady()
    expect(third.handle.doc()).toEqual({ count: 2000 })
    expect(A.getAllChanges(third.document.doc)).toHaveLength(2001)
  }, 20000)

  it("retries failed fragment persistence without losing already-saved loose commits", async () => {
    const store = backend()
    storage.beforeSave = async key => {
      if (key.includes("/fragments/")) throw new Error("fragment save failed")
    }
    const c = controller(store, fragmentFixture())
    await expect(c.flush()).rejects.toBeInstanceOf(AggregateError)
    expect(
      (await storage.list("subduction-v1/")).some(k => k.includes("/commits/"))
    ).toBe(true)
    storage.beforeSave = undefined
    await c.flush()
    await c.close()
    await store.close()
    const reloaded = controller(backend())
    await reloaded.query.whenReady()
    expect(reloaded.handle.doc()).toEqual({ count: 1999 })
    expect(A.getAllChanges(reloaded.document.doc)).toHaveLength(2000)
  }, 20000)

  it("does not let a fragment boundary hide an unapplied change with missing dependencies", async () => {
    const doc = fragmentFixture()
    let unrelated = A.init<State>({ actor: "11112222" })
    unrelated = A.change(unrelated, { time: 0 }, d => {
      d.count = -1
    })
    unrelated = A.change(unrelated, { time: 0 }, d => {
      d.count = -2
    })
    const [missing, pending] = A.getAllChanges(unrelated).map(blob => {
      const decoded = A.decodeChange(blob)
      return {
        kind: "commit",
        id: commitId(decoded.hash),
        parents: decoded.deps.map(commitId),
        blob,
      } satisfies LooseCommitRecord
    })
    const records = extractRecords(doc)
    const fragment = records.find(r => r.kind === "fragment")!
    // Standalone Automerge bundles cannot authenticate these boundary claims.
    const batch = records.map(r =>
      r === fragment
        ? { ...fragment, boundary: [...fragment.boundary, pending.id] }
        : r
    )
    const store = backend()
    await store.store(id, [...batch, pending])
    const c = controller(store)
    await c.synchronize()
    await vi.waitFor(() =>
      expect(A.getAllChanges(c.document.doc)).toHaveLength(2000)
    )
    expect(A.hasHeads(c.document.doc, [pending.id])).toBe(false)
    expect(c.query.peek().state).toBe("loading")
    await store.store(id, [missing])
    await c.query.whenReady()
    expect(A.hasHeads(c.document.doc, [pending.id])).toBe(true)
    expect(A.getAllChanges(c.document.doc)).toHaveLength(2002)
  }, 20000)

  it("can become ready when a previously absent document arrives through the real backend", async () => {
    const store = backend()
    const c = controller(store)
    await expect(c.query.whenReady()).rejects.toThrow("unavailable")
    await store.store(id, extractRecords(created()))
    await vi.waitFor(() => expect(c.query.peek().state).toBe("ready"))
    expect(c.handle.doc()).toEqual({ count: 0 })
  })

  it("retains and retries a real disk failure despite the persisted self-echo", async () => {
    const store = backend()
    let saves = 0
    storage.beforeSave = async key => {
      if (key.includes("/commits/") && ++saves === 2)
        throw new Error("temporary disk failure")
    }
    const c = controller(store, created())
    c.handle.change(
      d => {
        d.count = 1
      },
      { time: 0 }
    )
    await expect(c.flush()).rejects.toBeInstanceOf(AggregateError)
    expect(c.handle.doc()).toEqual({ count: 1 })
    storage.beforeSave = undefined
    await c.flush()
    await c.close()
    await store.close()
    const reopened = controller(backend())
    await reopened.query.whenReady()
    expect(reopened.handle.doc()).toEqual({ count: 1 })
  })

  it("rescans ambiguous disk failure instead of leaving an existing controller stuck", async () => {
    const store = backend()
    const c = controller(store)
    await expect(c.query.whenReady()).rejects.toThrow("unavailable")
    const save = storage.save.bind(storage)
    let fail = true
    vi.spyOn(storage, "save").mockImplementation(async (key, value) => {
      await save(key, value)
      if (key.includes("/commits/") && fail) {
        fail = false
        throw new Error("save committed but acknowledgement was lost")
      }
    })
    await expect(store.store(id, extractRecords(created()))).rejects.toThrow()
    await vi.waitFor(() => expect(c.query.peek().state).toBe("ready"))
    expect(c.handle.doc()).toEqual({ count: 0 })
    await expect(c.flush()).rejects.toBeInstanceOf(AggregateError)
    await c.flush()
  })

  it("invalidates immediately on deletion and drains earlier writes before real storage removal", async () => {
    const store = backend()
    const entered = deferred(),
      release = deferred()
    storage.beforeSave = async key => {
      if (key.includes("/commits/")) {
        entered.resolve()
        await release.promise
      }
    }
    const c = controller(store, created())
    await entered.promise
    const deletion = c.deleteLocal()
    expect(c.handle.isDeleted()).toBe(true)
    release.resolve()
    await deletion
    expect(await storage.list("subduction-v1/")).toEqual([])
    const reopened = controller(store)
    await expect(reopened.query.whenReady()).rejects.toThrow("unavailable")
  })
})
