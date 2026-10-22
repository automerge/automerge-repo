// Node fullfat initializes the SAME runtime used by implementation's slim import.
import * as N from "@automerge/subduction"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  commitId,
  sedimentreeId,
  type LooseCommitRecord,
  type SedimentreeEvent,
  type SedimentreeSession,
} from "@automerge/automerge-repo/sedimentree"
import {
  SubductionBackend,
  type SubductionBackendOptions,
} from "../src/index.js"
import { nativeId, logicalId } from "../src/storage.js"
import { TestStore, deferred, savedKeys, storedRecords } from "./storage.js"
import { corruptFrame } from "./frame.js"
import type { TestSigner } from "./transport.js"

const tree = sedimentreeId("ab".repeat(16))
const cid = (n: number) => commitId(n.toString(16).padStart(64, "0"))
const record = (n: number, parents: number[] = []): LooseCommitRecord => ({
  kind: "commit",
  id: cid(n),
  parents: parents.map(cid),
  blob: new Uint8Array([n, 42]),
})
let currentStorage: TestStore
async function initial(session: SedimentreeSession, id = tree) {
  const iterator = session.events[Symbol.asyncIterator]()
  const records: LooseCommitRecord[] = []
  const blobs: Uint8Array[] = []
  for (;;) {
    const result = await iterator.next()
    if (result.done) throw new Error("Missing local load marker")
    if (result.value.type === "failure") throw result.value.error
    if (result.value.type === "records")
      records.push(...(result.value.records as LooseCommitRecord[]))
    if (result.value.type === "blobs") blobs.push(...result.value.blobs)
    if (result.value.type === "local-load-complete") {
      // Legacy metadata assertions below inspect the test store separately;
      // open itself must deliver only Subduction's blobs.
      const available = (await storedRecords(
        currentStorage,
        id
      )) as LooseCommitRecord[]
      for (const blob of blobs) {
        const index = available.findIndex(record =>
          Buffer.from(record.blob).equals(blob)
        )
        if (index < 0) throw new Error("Initial blob missing from test store")
        records.push(available.splice(index, 1)[0])
      }
      return { records, blobs, complete: result.value, iterator }
    }
  }
}
/** Loose commits native holds for `tree`, hydrating on demand. Reaches the
 * private engine: the backend deliberately exposes no native accessor. */
async function nativeCommits(backend: SubductionBackend): Promise<number> {
  const engine = (backend as unknown as { engine: N.Subduction }).engine
  return ((await engine.getCommits(nativeId(tree))) ?? []).length
}
async function next(iterator: AsyncIterator<SedimentreeEvent>) {
  const value = await iterator.next()
  if (value.done) throw new Error("Unexpected end")
  return value.value
}

describe("real local Subduction", () => {
  let storage: TestStore, signer: TestSigner
  let backends: SubductionBackend[]
  const create = (limits: Partial<SubductionBackendOptions> = {}) => {
    const backend = new SubductionBackend({
      storage,
      signer,
      ...limits,
    })
    backends.push(backend)
    return backend
  }
  beforeEach(async () => {
    storage = new TestStore()
    currentStorage = storage
    signer = N.createMemorySigner(new Uint8Array(32).fill(42))
    backends = []
  })
  afterEach(async () => {
    for (const backend of backends) {
      await backend.flush().catch(() => {})
      await backend.close().catch(() => {})
    }
    vi.restoreAllMocks()
  })

  it("mints distinct IDs and stores initial history before returning", async () => {
    const backend = create()
    const first = await backend.create([record(1)])
    const second = await backend.create([record(1)])
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(second).not.toBe(first)
    expect((await initial(backend.open(first), first)).records).toEqual([
      record(1),
    ])
    expect((await initial(backend.open(second), second)).records).toEqual([
      record(1),
    ])
    await expect(backend.create([])).rejects.toMatchObject({
      operation: "create",
      code: "invalid-record",
    })
  })

  /** Hold this store's first scan of `id` until released. */
  function blockScan(id = tree) {
    const entered = deferred(),
      release = deferred()
    const load = storage.loadPrefix.bind(storage)
    const scan = `subduction-v2/trees/${id.padEnd(64, "0")}/`
    let blocked = false
    vi.spyOn(storage, "loadPrefix").mockImplementation(async prefix => {
      if (!blocked && prefix.startsWith(scan)) {
        blocked = true
        entered.resolve()
        await release.promise
      }
      return load(prefix)
    })
    return { entered: entered.promise, release: release.resolve }
  }

  it("opens via a native stored stream", async () => {
    const backend = create()
    await backend.store(tree, [record(1)])
    const internals = backend as unknown as { engine: N.Subduction }
    const native = vi.spyOn(internals.engine, "loadAndWatch")
    const loaded = await initial(backend.open(tree))
    expect(native).toHaveBeenCalledOnce()
    expect(loaded.blobs).toEqual([record(1).blob])
    expect(loaded.complete).toMatchObject({ found: true })
    expect(loaded.complete.marker).toBeUndefined()
  })

  it("delivers blobs isolated between sessions", async () => {
    const backend = create()
    await backend.store(tree, [record(1)])
    const first = await initial(backend.open(tree))
    const second = await initial(backend.open(tree))
    expect(first.blobs[0]).not.toBe(second.blobs[0])
    first.blobs[0].fill(0)
    expect(second.blobs).toEqual([record(1).blob])
    expect((await initial(backend.open(tree))).blobs).toEqual([record(1).blob])
  })

  it("starts unrelated opens while another initial scan is pending", async () => {
    const backend = create()
    const otherTree = sedimentreeId("cd".repeat(16))
    const scan = blockScan()
    const first = backend.open(tree)
    await scan.entered
    const other = await initial(backend.open(otherTree), otherTree)
    expect(other.complete.found).toBe(false)
    scan.release()
    expect((await initial(first)).complete.found).toBe(false)
    await backend.close()
  })

  it("closes while an initial scan is pending", async () => {
    const backend = create()
    const engine = (backend as unknown as { engine: N.Subduction }).engine
    const scan = blockScan()
    const freed = vi.spyOn(engine, "free")
    const iterator = backend.open(tree).events[Symbol.asyncIterator]()
    await scan.entered
    const closing = backend.close()
    scan.release()
    await closing
    expect(freed).toHaveBeenCalledOnce()
    expect((await iterator.next()).done).toBe(true)
  })

  it("deletes while an initial scan is pending and keeps other sessions observing", async () => {
    const backend = create()
    const otherTree = sedimentreeId("cd".repeat(16))
    const other = await initial(backend.open(otherTree), otherTree)
    const scan = blockScan()
    const iterator = backend.open(tree).events[Symbol.asyncIterator]()
    await scan.entered
    const deletion = backend.deleteLocal(tree)
    scan.release()
    await deletion
    expect(await next(iterator)).toMatchObject({ type: "deleted" })
    await backend.store(otherTree, [record(1)])
    // Live, or within the restarted stream's replay.
    let event = await next(other.iterator)
    while (event.type !== "records" && event.type !== "blobs")
      event = await next(other.iterator)
    expect(
      event.type === "records" ? event.records[0].blob : event.blobs[0]
    ).toEqual(record(1).blob)
    await backend.close()
  })

  it("delivers every live update to a consumer that reads late", async () => {
    const backend = create()
    const { iterator } = await initial(backend.open(tree))
    const records = [record(1), record(2, [1]), record(3, [2])]
    await backend.store(tree, records)
    // Native delivers one item per pull; let it outrun this consumer.
    await new Promise(resolve => setTimeout(resolve, 50))
    const blobs: Uint8Array[] = []
    while (blobs.length < 3) {
      const event = await next(iterator)
      if (event.type === "records")
        blobs.push(...event.records.map(r => r.blob))
      else if (event.type === "blobs") blobs.push(...event.blobs)
    }
    expect(blobs).toEqual(expect.arrayContaining(records.map(r => r.blob)))
    await backend.close()
  })

  it("delivers a save between native commit and fragment loads", async () => {
    const writer = create()
    await writer.store(tree, [record(1)])
    const reader = create()
    const load = storage.loadPrefix.bind(storage)
    let intercepted = false
    vi.spyOn(storage, "loadPrefix").mockImplementation(async prefix => {
      const entries = await load(prefix)
      if (!intercepted && prefix.includes("/commits/")) {
        intercepted = true
        // Queued behind this scan in the reader's bridge.
        void reader.store(tree, [record(2, [1])])
      }
      return entries
    })
    const loaded = await initial(reader.open(tree))
    expect(intercepted).toBe(true)
    // Native retries a scan overlapped by its own write; no gap either way.
    if (loaded.records.length < 2)
      expect(await next(loaded.iterator)).toMatchObject({
        type: "records",
        phase: "live",
        records: [record(2, [1])],
      })
    else expect(loaded.records).toEqual([record(1), record(2, [1])])
  })

  it("retries an initial scan overlapped by a same-document save", async () => {
    const backend = create()
    await backend.store(tree, [record(1)])
    const scan = blockScan()
    const session = backend.open(tree)
    await scan.entered
    const write = backend.store(tree, [record(2, [1])])
    scan.release()
    const loaded = await initial(session)
    await write
    expect(loaded.records).toEqual([record(1), record(2, [1])])
    await backend.close()
  })

  it("reports a rejected storage read as a terminal open failure", async () => {
    const backend = create()
    vi.spyOn(storage, "loadPrefix").mockRejectedValue(
      new Error("unreadable storage")
    )
    const iterator = backend.open(tree).events[Symbol.asyncIterator]()
    expect(await next(iterator)).toMatchObject({
      type: "failure",
      error: {
        operation: "open",
        message: expect.stringContaining("unreadable storage"),
      },
    })
    expect((await iterator.next()).done).toBe(true)
  })

  it("accepts backend-only IDs and rejects creating an existing ID without merging or poisoning flush", async () => {
    const backend = create()
    const full = sedimentreeId("cd".repeat(32))
    for (const id of [tree, full]) {
      const empty = backend.open(id)
      await initial(empty, id)
      await empty.close()
      // Concurrent creates are not fenced; only an already-stored ID conflicts.
      await expect(
        backend.create([record(1)], { documentId: id })
      ).resolves.toBe(id)
      const second = backend.create([record(2)], { documentId: id })
      await expect(second).rejects.toMatchObject({
        operation: "create",
        code: "conflict",
      })
      expect((await initial(backend.open(id), id)).records).toEqual([record(1)])
      await backend.flush()
      await backend.deleteLocal(id)
      await expect(
        backend.create([record(2)], { documentId: id })
      ).resolves.toBe(id)
    }
    await expect(
      backend.create([record(1)], { documentId: "invalid" as typeof tree })
    ).rejects.toThrow(TypeError)
  })

  it("persists native signed bytes, opaque commit identities and parents; reloads through a fresh engine", async () => {
    const backend = create()
    await backend.store(tree, [record(2, [1]), record(1)])
    const keys = await storage.list("subduction-v2/")
    const key = keys.find(k => k.endsWith(`/signed/${cid(2)}`))!
    expect((await storage.load(key))!.length).toBeGreaterThan(0)
    const engine = (backend as unknown as { engine: N.Subduction }).engine
    const commit = ((await engine.getCommits(nativeId(tree))) ?? []).find(
      c => c.head === cid(2)
    )!
    expect(commit.parents).toEqual([cid(1)])
    expect(commit.head).not.toBe(commit.blobMeta.digest)
    expect((await initial(backend.open(tree))).records).toEqual([
      record(1),
      record(2, [1]),
    ])
    await backend.close()
    // Signer is borrowed and remains usable after native disconnect/free.
    expect((await signer.sign(new Uint8Array([1]))).length).toBe(64)
    const loadPrefix = vi.spyOn(storage, "loadPrefix")
    const reload = create()
    const hydration = vi.spyOn(
      (reload as unknown as { engine: N.Subduction }).engine,
      "getCommits"
    )
    const loaded = await initial(reload.open(tree))
    // Native reads commits and fragments once each; the rest are the test
    // helper's own scratch-node reads.
    expect(hydration).not.toHaveBeenCalled()
    const total = loadPrefix.mock.calls.length
    await storedRecords(storage, tree)
    expect(total - (loadPrefix.mock.calls.length - total)).toBe(2)
    expect(loaded.records).toEqual([record(1), record(2, [1])])
    expect(loaded.complete.marker).toBeUndefined()
    // Native hydrates on demand from storage and finds both commits.
    await expect(nativeCommits(reload)).resolves.toBe(2)
  })

  it.each(["before", "after"])(
    "delivers an exact native duplicate written externally %s watch installation",
    async timing => {
      const a = create()
      if (timing === "before") await a.store(tree, [record(1)])
      const b = create()
      const loaded = await initial(b.open(tree))
      expect(loaded.records).toEqual(timing === "before" ? [record(1)] : [])
      if (timing === "after") await a.store(tree, [record(1)])
      // Sequential external writes test notification recovery, not shared ownership.
      await b.store(tree, [record(1)])
      expect(await next(loaded.iterator)).toMatchObject({
        type: "records",
        phase: "live",
        records: [record(1)],
      })
      expect(await next(loaded.iterator)).toMatchObject({
        type: "history-marker",
        marker: { heads: [cid(1)] },
      })
      expect((await initial(b.open(tree))).records).toEqual([record(1)])
      // The local write hydrated native, which holds the one record.
      await expect(nativeCommits(b)).resolves.toBe(1)
      await loaded.iterator.return!()
    }
  )

  it("converges on repeated duplicate stores", async () => {
    const backend = create()
    await backend.store(tree, [record(1)])
    const { iterator } = await initial(backend.open(tree))
    for (let i = 0; i < 3; i++) await backend.store(tree, [record(1)])
    await iterator.return!()
    expect((await initial(backend.open(tree))).records).toEqual([record(1)])
    await expect(nativeCommits(backend)).resolves.toBe(1)
  })

  it("maps 16-byte IDs by zero-padding, preserves native 32-byte IDs without truncation", async () => {
    const full = sedimentreeId("ab".repeat(16) + "cd".repeat(16))
    for (const id of [tree, full]) {
      const native = nativeId(id)
      expect(native).toBe(id.padEnd(64, "0"))
      expect(logicalId(native)).toBe(id)
    }
    const backend = create()
    await backend.store(tree, [record(1)])
    await backend.store(full, [record(2)])
    expect((await initial(backend.open(tree))).records).toEqual([record(1)])
    expect((await initial(backend.open(full), full)).records).toEqual([
      record(2),
    ])
  })

  it("delivers writes accepted after open without a gap and copies inputs before await", async () => {
    const backend = create()
    await backend.store(tree, [record(1)])
    const session = backend.open(tree)
    const parents = [cid(1)],
      blob = Buffer.from([2, 42])
    const write = backend.store(tree, [
      { kind: "commit", id: cid(2), parents, blob },
    ])
    parents.length = 0
    blob.fill(0)
    await write
    const loaded = await initial(session)
    // The native scan may include a write accepted just after open.
    if (loaded.records.length < 2) {
      const live = await next(loaded.iterator)
      expect(live).toMatchObject({
        type: "records",
        phase: "live",
        records: [record(2, [1])],
      })
      if (live.type === "records") live.records[0].blob.fill(0)
    } else expect(loaded.records).toEqual([record(1), record(2, [1])])
    loaded.blobs.forEach(blob => blob.fill(0))
    expect((await initial(backend.open(tree))).records).toEqual([
      record(1),
      record(2, [1]),
    ])
  })

  it("cancellation cancels only the synchronization wait; iterator return wakes pending pulls", async () => {
    const backend = create()
    const session = backend.open(tree)
    const { iterator } = await initial(session)
    const gate = deferred(),
      entered = deferred()
    storage.beforeSave = async key => {
      if (key.includes("/commits/")) {
        entered.resolve()
        await gate.promise
      }
    }
    const writing = backend.store(tree, [record(1)])
    await entered.promise
    const controller = new AbortController()
    const wait = session.synchronize({ signal: controller.signal })
    controller.abort(new Error("cancel wait"))
    await expect(wait).rejects.toThrow("cancel wait")
    gate.resolve()
    await writing
    // The round does not wait for the in-flight write; only each kind's
    // content is fixed, not their relative order.
    const events = [
      await next(iterator),
      await next(iterator),
      await next(iterator),
    ]
    expect(events.map(e => e.type).sort()).toEqual([
      "history-marker",
      "records",
      "synchronized",
    ])
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "history-marker",
        marker: expect.objectContaining({ heads: [cid(1)] }),
      })
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "synchronized",
        result: expect.objectContaining({ outcome: "no-peers" }),
      })
    )
    const pending = iterator.next()
    await iterator.return!()
    expect((await pending).done).toBe(true)
    await expect(session.synchronize()).rejects.toMatchObject({
      code: "closed",
    })
  })

  it("writes a submission of any size in one native call, in order", async () => {
    const backend = create()
    const records = Array.from({ length: 200 }, (_, i) =>
      record(i + 1, i ? [i] : [])
    )
    const native = vi.spyOn(N.Subduction.prototype, "storeBatch")
    await backend.store(tree, records)
    expect(native.mock.calls.map(([, batch]) => batch.commits?.length)).toEqual(
      [200]
    )
    const loaded = await initial(backend.open(tree))
    expect(loaded.records).toEqual(records)
    expect(loaded.complete.marker).toBeUndefined()
  })

  it("stores none of a batch after a mid-batch failure; a full retry completes it", async () => {
    const backend = create()
    const { iterator } = await initial(backend.open(tree))
    const records = Array.from({ length: 10 }, (_, i) =>
      record(i + 1, i ? [i] : [])
    )
    let writes = 0
    storage.beforeSave = async key => {
      // Fail the 5th record: the whole batch must be refused.
      if (key.includes("/commits/") && ++writes === 5)
        throw new Error("disk failed")
    }
    await expect(backend.store(tree, records)).rejects.toThrow()
    // Native recovers by rescanning: nothing of the failed batch surfaces.
    expect(await next(iterator)).toMatchObject({
      type: "history-marker",
      marker: { heads: [] },
    })
    expect((await initial(backend.open(tree))).records).toEqual([])
    storage.beforeSave = undefined
    const save = vi.spyOn(storage, "saveBatch")
    await backend.store(tree, records)
    // Native registers the tree ID separately; records go in one batch.
    expect(
      save.mock.calls.filter(([entries]) =>
        entries.some(([key]) => key.includes("/commits/"))
      )
    ).toHaveLength(1)
    expect(
      savedKeys(save).filter(key => key.includes("/commits/"))
    ).toHaveLength(20)
    const reloaded = await initial(backend.open(tree))
    expect(reloaded.records).toEqual(records)
    expect(reloaded.complete.marker).toBeUndefined()
  })

  it("has no total-history cap: a tree grown past any old budget reopens, enumerates and deletes", async () => {
    // Legacy batch limit does not cap the initial native blob delivery.
    const backend = create()
    for (let n = 1; n <= 40; n++)
      await backend.store(tree, [record(n, n > 1 ? [n - 1] : [])])
    await backend.close()
    const reopened = create()
    const loaded = await initial(reopened.open(tree))
    expect(loaded.records).toHaveLength(40)
    expect(loaded.complete.marker).toBeUndefined()
    await reopened.deleteLocal(tree)
    expect(await storage.list("subduction-v2/")).toEqual([])
  })

  it("stores with constant storage work and no live marker rescans once complete", async () => {
    const backend = create()
    const engine = (backend as unknown as { engine: N.Subduction }).engine
    const getHeads = vi.spyOn(engine, "getHeads")
    await backend.store(tree, [record(1)])
    const session = backend.open(tree)
    const { iterator } = await initial(session)
    session.markComplete!()
    const list = vi.spyOn(storage, "list")
    const load = vi.spyOn(storage, "loadMany")
    await backend.store(tree, [record(2, [1])])
    expect(await next(iterator)).toMatchObject({
      type: "records",
      records: [record(2, [1])],
    })
    await session.synchronize()
    expect(await next(iterator)).toMatchObject({
      type: "synchronized",
      result: { outcome: "no-peers", marker: { heads: [cid(2)] } },
    })
    expect(list).not.toHaveBeenCalled()
    expect(getHeads).toHaveBeenCalledOnce()
    // The bridge does no preflight reads.
    expect(load).not.toHaveBeenCalled()
    // Readers still validate the authoritative stored history.
    expect((await initial(backend.open(tree))).records).toEqual([
      record(1),
      record(2, [1]),
    ])
  })

  it("emits storage markers only to incomplete sessions", async () => {
    const backend = create()
    const done = backend.open(tree)
    const loading = backend.open(tree)
    const a = await initial(done)
    const b = await initial(loading)
    done.markComplete!()
    await backend.store(tree, [record(1)])
    expect(await next(a.iterator)).toMatchObject({ type: "records" })
    expect(await next(b.iterator)).toMatchObject({ type: "records" })
    expect(await next(b.iterator)).toMatchObject({
      type: "history-marker",
      marker: { heads: [cid(1)] },
    })
    await done.synchronize()
    expect(await next(a.iterator)).toMatchObject({
      type: "synchronized",
      result: { marker: { heads: [cid(1)] } },
    })
  })

  it("waits past a delayed save before publishing native heads to an incomplete session", async () => {
    const backend = create()
    await backend.store(tree, [record(1)])
    const { iterator } = await initial(backend.open(tree))
    const engine = (backend as unknown as { engine: N.Subduction }).engine
    const native = nativeId(tree)
    const entered = deferred(),
      release = deferred()
    const headsDuringSave: string[][] = []
    storage.afterSave = async keys => {
      if (!keys.some(key => key.endsWith(`/signed/${cid(2)}`))) return
      headsDuringSave.push((await engine.getHeads(native)) ?? [])
      entered.resolve()
      await release.promise
    }
    try {
      const writing = backend.store(tree, [record(2, [1])])
      await entered.promise
      expect(headsDuringSave).toEqual([[cid(1)]])
      release.resolve()
      await writing
      expect(await next(iterator)).toMatchObject({
        type: "records",
        records: [record(2, [1])],
      })
      expect(await next(iterator)).toMatchObject({
        type: "history-marker",
        marker: { heads: [cid(2)] },
      })
    } finally {
      release.resolve()
      storage.afterSave = undefined
    }
  })

  it("publishes both branches from a batch as live heads", async () => {
    const backend = create()
    await backend.store(tree, [record(1)])
    const { iterator } = await initial(backend.open(tree))
    await backend.store(tree, [record(2, [1]), record(3, [1])])
    const live = [await next(iterator), await next(iterator)]
    expect(live).toEqual([
      expect.objectContaining({ type: "records", records: [record(2, [1])] }),
      // Native publishes the batch after updating its heads.
      expect.objectContaining({
        type: "history-marker",
        marker: expect.objectContaining({ heads: [cid(2), cid(3)] }),
      }),
    ])
    expect(await next(iterator)).toMatchObject({
      type: "records",
      records: [record(3, [1])],
    })
  })

  it("reopening after a session closes reloads blobs and retains sync markers", async () => {
    const backend = create()
    await backend.store(tree, [record(1), record(2, [1])])
    const first = backend.open(tree)
    await initial(first)
    first.markComplete!()
    await first.close()
    const second = backend.open(tree)
    const { iterator, complete } = await initial(second)
    expect(complete.marker).toBeUndefined()
    second.markComplete!()
    await backend.store(tree, [record(3, [2])])
    expect((await next(iterator)).type).toBe("records")
    await second.synchronize()
    expect(await next(iterator)).toMatchObject({
      type: "synchronized",
      result: { marker: { heads: [cid(3)] } },
    })
  })

  it("reports malformed persisted fragments rather than treating them as absent", async () => {
    const backend = create()
    await storage.save(
      `subduction-v2/trees/${tree.padEnd(64, "0")}/fragments/signed/${cid(1)}`,
      new Uint8Array([1])
    )
    const iterator = backend.open(tree).events[Symbol.asyncIterator]()
    expect(await next(iterator)).toMatchObject({
      type: "failure",
      error: { code: "io" },
    })
    expect((await iterator.next()).done).toBe(true)
    // Deletion goes through native and does not need a readable tree.
    await backend.deleteLocal(tree)
    expect(await storage.list("subduction-v2/")).toEqual([])
  })

  // The bridge pairs stored values and decodes signed frames; Subduction
  // checks blob integrity after receiving them.
  it.each(["malformed", "missing-blob", "signed", "blob"] as const)(
    "fails loudly on persisted %s corruption",
    async kind => {
      const backend = create()
      await backend.store(tree, [record(1)])
      await backend.close()
      const key = (await storage.list("subduction-v2/")).find(k =>
        k.includes("/commits/signed/")
      )!
      if (kind === "missing-blob")
        await storage.remove(key.replace("/signed/", "/blob/"))
      else if (kind === "blob")
        await storage.save(
          key.replace("/signed/", "/blob/"),
          new Uint8Array([99])
        )
      else
        await storage.save(
          key,
          kind === "malformed"
            ? new Uint8Array([1])
            : corruptFrame((await storage.load(key))!, "signed")
        )
      const iterator = create().open(tree).events[Symbol.asyncIterator]()
      expect(await next(iterator)).toMatchObject({ type: "failure" })
      expect((await iterator.next()).done).toBe(true)
    }
  )

  it("rescans after a failed batch and retries safely", async () => {
    const backend = create()
    const { iterator } = await initial(backend.open(tree))
    let count = 0
    storage.beforeSave = async key => {
      if (key.includes("/commits/") && ++count === 2)
        throw new Error("disk failed")
    }
    await expect(backend.store(tree, [record(1), record(2)])).rejects.toThrow()
    expect(await next(iterator)).toMatchObject({
      type: "history-marker",
      marker: { heads: [] },
    })
    expect((await initial(backend.open(tree))).records).toEqual([])
    storage.beforeSave = undefined
    await backend.store(tree, [record(1), record(2)])
    // The original session keeps observing after recovery.
    let event = await next(iterator)
    while (event.type !== "records") event = await next(iterator)
    expect(event).toMatchObject({ phase: "live" })
    expect((await initial(backend.open(tree))).records).toEqual([
      record(1),
      record(2),
    ])
  })

  it("recovers record observations when save commits bytes but then rejects", async () => {
    const backend = create()
    const { iterator } = await initial(backend.open(tree))
    let fail = true
    storage.afterSave = keys => {
      if (keys.some(key => key.includes("/commits/")) && fail) {
        fail = false
        throw new Error("ambiguous write outcome")
      }
    }
    await expect(backend.store(tree, [record(1)])).rejects.toThrow()
    // The committed bytes return through native's recovery scan.
    expect(await next(iterator)).toMatchObject({
      type: "blobs",
      blobs: [record(1).blob],
    })
    const retry = await initial(backend.open(tree))
    expect(retry.records).toEqual([record(1)])
    await backend.store(tree, [record(1)])
    expect(await next(retry.iterator)).toMatchObject({
      type: "records",
      phase: "live",
      records: [record(1)],
    })
    await retry.iterator.return!()
    expect((await initial(backend.open(tree))).records).toEqual([record(1)])
  })

  it("enumerates a registered tree even if its batch fails", async () => {
    const backend = create()
    storage.beforeSave = async key => {
      if (key.includes("/commits/")) throw new Error("disk failed")
    }
    await expect(backend.store(tree, [record(1)])).rejects.toThrow()
    expect(await storage.list("subduction-v2/ids/")).toEqual([
      `subduction-v2/ids/${tree.padEnd(64, "0")}`,
    ])
  })

  it("flush drains in-flight stores and reports their failures without retaining them", async () => {
    const backend = create()
    const gate = deferred(),
      entered = deferred()
    storage.beforeSave = async key => {
      if (key.includes("/commits/")) {
        entered.resolve()
        await gate.promise
        throw new Error("disk failed")
      }
    }
    const writing = backend.store(tree, [record(1)]).catch(e => e)
    await entered.promise
    let settled = false
    const flushing = backend.flush([tree]).finally(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    gate.resolve()
    await expect(flushing).rejects.toBeInstanceOf(AggregateError)
    await writing
    storage.beforeSave = undefined
    // Repo keeps each document's failure; the backend does not.
    await backend.flush()
    await backend.close()
    await expect(backend.flush()).rejects.toMatchObject({ code: "closed" })
  })

  it("acknowledges stores to one tree in submission order", async () => {
    const backend = create()
    const gate = deferred(),
      entered = deferred()
    storage.beforeSave = async key => {
      if (key.endsWith(`/signed/${cid(1)}`)) {
        entered.resolve()
        await gate.promise
        throw new Error("disk failed")
      }
    }
    const first = backend.store(tree, [record(1)]).catch(e => e)
    await entered.promise
    // The later save completes on its own, but is not acknowledged before or
    // without the earlier one.
    let acknowledged = false
    const second = backend.store(tree, [record(2, [1])]).then(() => {
      acknowledged = true
    })
    await vi.waitFor(async () =>
      expect(
        (await storage.list("subduction-v2/")).some(key =>
          key.endsWith(`/signed/${cid(2)}`)
        )
      ).toBe(true)
    )
    expect(acknowledged).toBe(false)
    gate.resolve()
    await expect(second).rejects.toMatchObject({ operation: "store" })
    expect(await first).toBeInstanceOf(Error)
  })

  it("fences deletion immediately and allows later reacquisition", async () => {
    const backend = create()
    await backend.store(tree, [record(1)])
    const { iterator } = await initial(backend.open(tree))
    const deleting = backend.deleteLocal(tree)
    expect(await next(iterator)).toMatchObject({ type: "deleted" })
    expect((await iterator.next()).done).toBe(true)
    await expect(backend.store(tree, [record(2)])).rejects.toMatchObject({
      code: "deleted",
    })
    await deleting
    expect(await storage.list("subduction-v2/")).toEqual([])
    expect((await initial(backend.open(tree))).complete.found).toBe(false)
    await backend.store(tree, [record(2)])
    expect((await initial(backend.open(tree))).records).toEqual([record(2)])
  })

  it("deletion drains a local write already in flight", async () => {
    const backend = create()
    const gate = deferred(),
      entered = deferred()
    storage.beforeSave = async key => {
      if (key.includes("/commits/")) {
        entered.resolve()
        await gate.promise
      }
    }
    const writing = backend.store(tree, [record(1)])
    await entered.promise
    const deleting = backend.deleteLocal(tree)
    gate.resolve()
    await writing
    await deleting
    expect(await storage.list("subduction-v2/")).toEqual([])
  })

  it("flush waits for an accepted deletion, but not another document's", async () => {
    const backend = create()
    const otherTree = sedimentreeId("cd".repeat(16))
    await backend.store(tree, [record(1)])
    const gate = deferred()
    const engine = (backend as unknown as { engine: N.Subduction }).engine
    const remove = engine.removeSedimentree.bind(engine)
    vi.spyOn(engine, "removeSedimentree").mockImplementationOnce(async id => {
      await gate.promise
      return remove(id)
    })
    const deleting = backend.deleteLocal(tree)
    await backend.flush([otherTree])
    let flushed = false
    const flushing = backend.flush([tree]).then(() => {
      flushed = true
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(flushed).toBe(false)
    gate.resolve()
    await flushing
    expect(await storage.list("subduction-v2/")).toEqual([])
    await deleting
  })

  it("flush reports a failed deletion once; later stores start fresh", async () => {
    const backend = create()
    await backend.store(tree, [record(1)])
    const internals = backend as unknown as { engine: N.Subduction }
    vi.spyOn(internals.engine, "removeSedimentree").mockRejectedValueOnce(
      new Error("removal failed")
    )
    const deleting = backend.deleteLocal(tree)
    const flushing = backend.flush([tree])
    await expect(deleting).rejects.toMatchObject({ operation: "delete" })
    await expect(flushing).rejects.toMatchObject({
      errors: [expect.objectContaining({ operation: "delete" })],
    })
    await backend.flush([tree])
    await expect(backend.store(tree, [record(2)])).resolves.toBeUndefined()
  })

  it("close ends watches immediately but waits for accepted persistence and leaves borrowed disk intact", async () => {
    const backend = create()
    const { iterator } = await initial(backend.open(tree))
    const pending = iterator.next()
    const gate = deferred(),
      entered = deferred()
    storage.beforeSave = async key => {
      if (key.includes("/commits/")) {
        entered.resolve()
        await gate.promise
      }
    }
    const writing = backend.store(tree, [record(1)])
    await entered.promise
    const closing = backend.close()
    expect(backend.close()).toBe(closing)
    expect((await pending).done).toBe(true)
    await expect(backend.store(tree, [record(2)])).rejects.toMatchObject({
      code: "closed",
    })
    let done = false
    void closing.then(() => {
      done = true
    })
    await Promise.resolve()
    expect(done).toBe(false)
    gate.resolve()
    await writing
    await closing
    expect((await initial(create().open(tree))).records).toEqual([record(1)])
  })

  it("pins initial batches and allows immediate return during blocked acquisition", async () => {
    const backend = create()
    await backend.store(tree, [record(1)])
    await backend.store(tree, [record(2)])
    const session = backend.open(tree)
    const loaded = await initial(session)
    expect(loaded.records).toEqual([record(1), record(2)])
    const gate = deferred(),
      entered = deferred()
    storage.beforeSave = async key => {
      if (key.includes("/commits/")) {
        entered.resolve()
        await gate.promise
      }
    }
    const write = backend.store(tree, [record(3)])
    await entered.promise
    const waiting = backend.open(tree).events[Symbol.asyncIterator]()
    const pending = waiting.next()
    await waiting.return!()
    expect((await pending).done).toBe(true)
    gate.resolve()
    await write
  })
})
