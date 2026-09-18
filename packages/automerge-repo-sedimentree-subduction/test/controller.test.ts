import * as A from "@automerge/automerge"
import { MemorySigner } from "@automerge/subduction"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { idBytes, sedimentreeId } from "@automerge/automerge-repo-sedimentree"
import { extractRecords } from "../../automerge-repo-sedimentree-automerge/src/index.js"
import { SedimentreeDocumentController } from "../../automerge-repo/src/SedimentreeDocumentController.js"
import { binaryToDocumentId } from "../../automerge-repo/src/AutomergeUrl.js"
import type { BinaryDocumentId } from "../../automerge-repo/src/types.js"
import { SubductionBackend } from "../src/index.js"
import { DiskStore, deferred } from "./storage.js"

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
    // A deterministic actor/time avoids accidentally forming a fragment, which
    // the first real adapter explicitly does not support.
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

  it("recovers in a fresh process without rewriting the loaded history", async () => {
    const run = promisify(execFile)
    for (const mode of ["write", "read"]) {
      await run(process.execPath, [
        "--import",
        import.meta.resolve("tsx"),
        new URL("./fresh-process.ts", import.meta.url).pathname,
        mode,
        directory,
      ])
    }
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
