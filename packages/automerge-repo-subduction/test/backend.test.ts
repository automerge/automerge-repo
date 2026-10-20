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
import { nativeId, logicalId, StorageBridge } from "../src/storage.js"
import { TestStore, deferred, savedKeys } from "./storage.js"
import { corruptFrame, signedBytes } from "./frame.js"

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
      const native = nativeId(id)
      try {
        const available = (await new StorageBridge(currentStorage).records(
          native
        )) as LooseCommitRecord[]
        for (const blob of blobs) {
          const index = available.findIndex(record =>
            Buffer.from(record.blob).equals(blob)
          )
          if (index < 0) throw new Error("Initial blob missing from test store")
          records.push(available.splice(index, 1)[0])
        }
      } finally {
        native.free()
      }
      return { records, blobs, complete: result.value, iterator }
    }
  }
}
/** Loose commits native holds for `tree`, hydrating on demand. Reaches the
 * private engine: the backend deliberately exposes no native accessor. */
async function nativeCommits(backend: SubductionBackend): Promise<number> {
  const engine = (backend as unknown as { engine: N.Subduction }).engine
  const id = nativeId(tree)
  try {
    const commits = (await engine.getCommits(id)) ?? []
    commits.forEach(c => c.free())
    return commits.length
  } finally {
    id.free()
  }
}
async function next(iterator: AsyncIterator<SedimentreeEvent>) {
  const value = await iterator.next()
  if (value.done) throw new Error("Unexpected end")
  return value.value
}

describe("real local Subduction", () => {
  let storage: TestStore, signer: N.MemorySigner
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
  /** Paired values for `record`, produced by a scratch backend. */
  async function encodedPair(
    record: LooseCommitRecord
  ): Promise<[string, Uint8Array][]> {
    const scratch = new TestStore()
    const backend = new SubductionBackend({ storage: scratch, signer })
    try {
      await backend.store(tree, [record])
      return (await scratch.loadPrefix("subduction-v2/")).filter(([key]) =>
        key.includes("/commits/")
      )
    } finally {
      await backend.close()
    }
  }
  beforeEach(async () => {
    storage = new TestStore()
    currentStorage = storage
    signer = N.MemorySigner.fromBytes(new Uint8Array(32).fill(42))
    backends = []
  })
  afterEach(async () => {
    for (const backend of backends) {
      await backend.flush().catch(() => {})
      await backend.close().catch(() => {})
    }
    signer.free()
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

  it("opens via a native stored stream without a Repo-facing bridge records read", async () => {
    const backend = create()
    await backend.store(tree, [record(1)])
    const internals = backend as unknown as {
      engine: N.Subduction
      bridge: StorageBridge
    }
    const native = vi.spyOn(internals.engine, "loadAndWatch")
    const direct = vi.spyOn(internals.bridge, "records")
    const loaded = await initial(backend.open(tree))
    expect(native).toHaveBeenCalledOnce()
    expect(direct).not.toHaveBeenCalled()
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
    // The old engine's stream ended; the session restarted on its successor.
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

  it("starts opens arriving during retirement on the replacement engine", async () => {
    const backend = create()
    const internals = backend as unknown as {
      engine: N.Subduction
      bridge: StorageBridge
    }
    const oldRead = vi.spyOn(internals.engine, "loadAndWatch")
    const originalClose = internals.engine.close.bind(internals.engine)
    const entered = deferred(),
      release = deferred()
    vi.spyOn(internals.engine, "close").mockImplementationOnce(async () => {
      entered.resolve()
      await release.promise
      return originalClose()
    })
    const deletion = backend.deleteLocal(tree)
    await entered.promise
    const otherTree = sedimentreeId("cd".repeat(16))
    const session = backend.open(otherTree)
    expect(oldRead).not.toHaveBeenCalled()
    release.resolve()
    await deletion
    expect((await initial(session, otherTree)).complete.found).toBe(false)
    expect(oldRead).not.toHaveBeenCalled()
    await backend.close()
  })

  it("requires a rescan when live delivery overflows the session buffer", async () => {
    const backend = create({ replayEvents: 1 })
    const { iterator } = await initial(backend.open(tree))
    await backend.store(tree, [record(1), record(2, [1]), record(3, [2])])
    // Native delivers one item per pull; let it outrun this consumer.
    await new Promise(resolve => setTimeout(resolve, 50))
    let event = await next(iterator)
    while (event.type !== "rescan-required") event = await next(iterator)
    expect((await iterator.next()).done).toBe(true)
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
    const key = keys.find(k => k.endsWith(`/meta/${cid(2)}`))!
    const signed = N.SignedLooseCommit.tryDecode(
      signedBytes((await storage.load(key))!)
    )
    const payload = signed.payload
    const commit = payload.commitId,
      meta = payload.blobMeta,
      digest = meta.digest()
    expect(commit.toHexString()).toBe(cid(2))
    expect(commit.toHexString()).not.toBe(digest.toHexString())
    commit.free()
    digest.free()
    meta.free()
    payload.free()
    signed.free()
    expect((await initial(backend.open(tree))).records).toEqual([
      record(1),
      record(2, [1]),
    ])
    await backend.close()
    // Signer is borrowed and remains usable after native disconnect/free.
    expect((await signer.sign(new Uint8Array([1]))).length).toBe(64)
    const hydration = vi.spyOn(N.Subduction.prototype, "getCommits")
    const loadPrefix = vi.spyOn(storage, "loadPrefix")
    const reload = create()
    const loaded = await initial(reload.open(tree))
    // Native reads commits and fragments separately; the test helper reads
    // once more to verify legacy metadata assertions.
    expect(hydration).not.toHaveBeenCalled()
    expect(loadPrefix).toHaveBeenCalledTimes(3)
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
      const save = vi.spyOn(storage, "saveBatch")
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
      expect(savedKeys(save).filter(key => key.includes("/commits/"))).toEqual(
        []
      )
      expect((await initial(b.open(tree))).records).toEqual([record(1)])
      // The local write hydrated native, which holds the one record.
      await expect(nativeCommits(b)).resolves.toBe(1)
      await loaded.iterator.return!()
    }
  )

  it("bounds repeated durable duplicate notifications with rescan-required", async () => {
    const backend = create({ replayEvents: 2 })
    await backend.store(tree, [record(1)])
    const { iterator } = await initial(backend.open(tree))
    const save = vi.spyOn(storage, "saveBatch")
    for (let i = 0; i < 3; i++) await backend.store(tree, [record(1)])
    expect(await next(iterator)).toMatchObject({ type: "rescan-required" })
    expect((await iterator.next()).done).toBe(true)
    expect(savedKeys(save).filter(key => key.includes("/commits/"))).toEqual([])
    expect((await initial(backend.open(tree))).records).toEqual([record(1)])
  })

  it("maps 16-byte IDs by zero-padding, preserves native 32-byte IDs without truncation", async () => {
    const full = sedimentreeId("ab".repeat(16) + "cd".repeat(16))
    for (const id of [tree, full]) {
      const native = nativeId(id)
      expect(Buffer.from(native.toBytes()).toString("hex")).toBe(
        id.padEnd(64, "0")
      )
      expect(logicalId(native)).toBe(id)
      native.free()
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

  it("reports a stored-key conflict with its typed code before any write, without rescanning", async () => {
    const backend = create()
    await backend.store(tree, [record(1)])
    const list = vi.spyOn(storage, "list")
    const save = vi.spyOn(storage, "saveBatch")
    const variant = { ...record(1), blob: new Uint8Array([9, 42]) }
    await expect(backend.store(tree, [variant])).rejects.toMatchObject({
      operation: "store",
      code: "conflict",
    })
    expect(save).not.toHaveBeenCalled()
    expect(list).not.toHaveBeenCalled()
    // Flush reports the refused attempt once; the original record is intact.
    await expect(backend.flush()).rejects.toBeInstanceOf(AggregateError)
    expect((await initial(backend.open(tree))).records).toEqual([record(1)])
  })

  it("a conflict that races past the preflight is still refused by the bridge, as a retryable store failure", async () => {
    // Variant of record(1) lands between this backend's preflight and its
    // native write (a shared-store race). Native wraps the bridge's rejection,
    // so the typed conflict code is lost at this layer; what matters is that
    // the write is refused, nothing is overwritten, and the error belongs to
    // this store rather than being borrowed from another operation.
    const backend = create()
    const variant = { ...record(1), blob: new Uint8Array([9, 42]) }
    const original = storage.loadMany.bind(storage)
    let seeded = false
    vi.spyOn(storage, "loadMany").mockImplementation(async keys => {
      if (!seeded && keys[0].endsWith(`/meta/${cid(1)}`)) {
        seeded = true
        // Preflight sees "absent"; then the variant appears before the write.
        await storage.saveBatch(await encodedPair(variant))
        return keys.map(() => undefined)
      }
      return original(keys)
    })
    const failure = await backend.store(tree, [record(1)]).catch(e => e)
    expect(failure).toMatchObject({ operation: "store", code: "io" })
    expect(failure.retryable).toBe(true)
    vi.mocked(storage.loadMany).mockRestore()
    expect((await initial(backend.open(tree))).records).toEqual([variant])
  })

  it("writes a submission of any size in one native call, in order", async () => {
    const backend = create()
    const records = Array.from({ length: 200 }, (_, i) =>
      record(i + 1, i ? [i] : [])
    )
    const native = vi.spyOn(N.Subduction.prototype, "storeBuiltBatch")
    await backend.store(tree, records)
    expect(native.mock.calls.map(([, commits]) => commits.length)).toEqual([
      200,
    ])
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
    await expect(backend.flush()).rejects.toBeInstanceOf(AggregateError)
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
    await backend.flush()
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
    // One preflight lookup plus the bridge's own same-key check: per record,
    // independent of how much history the tree holds.
    const path = `subduction-v2/trees/${tree.padEnd(64, "0")}/commits/`
    const pair = [`${path}meta/${cid(2)}`, `${path}blob/${cid(2)}`]
    expect(load.mock.calls.map(([keys]) => keys)).toEqual([pair, pair])
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
      if (!keys.some(key => key.endsWith(`/meta/${cid(2)}`))) return
      const heads = (await engine.getHeads(native)) ?? []
      try {
        headsDuringSave.push(heads.map(head => head.toHexString()))
      } finally {
        heads.forEach(head => head.free())
      }
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
      native.free()
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

  it("bounded live overflow explicitly ends with rescan-required", async () => {
    const backend = create({ replayEvents: 1 })
    const session = backend.open(tree)
    const { iterator } = await initial(session)
    await backend.store(tree, [record(1)])
    await backend.store(tree, [record(2)])
    expect(await next(iterator)).toMatchObject({ type: "rescan-required" })
    expect((await iterator.next()).done).toBe(true)
    expect((await initial(backend.open(tree))).records).toHaveLength(2)
  })

  it("reports malformed persisted fragments rather than treating them as absent", async () => {
    const backend = create()
    await storage.save(
      `subduction-v2/trees/${tree.padEnd(64, "0")}/fragments/meta/${cid(1)}`,
      new Uint8Array([1])
    )
    const iterator = backend.open(tree).events[Symbol.asyncIterator]()
    expect(await next(iterator)).toMatchObject({
      type: "failure",
      error: { code: "io" },
    })
    expect((await iterator.next()).done).toBe(true)
    await expect(backend.deleteLocal(tree)).rejects.toThrow()
    expect(await storage.list("subduction-v2/")).toHaveLength(1)
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
        k.includes("/commits/meta/")
      )!
      if (kind === "missing-blob")
        await storage.remove(key.replace("/meta/", "/blob/"))
      else if (kind === "blob")
        await storage.save(
          key.replace("/meta/", "/blob/"),
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

  it("rescans after a failed batch, reports historical failure to flush, and retries safely", async () => {
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
    await expect(backend.flush()).rejects.toBeInstanceOf(AggregateError)
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
    await backend.flush()
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
    const save = vi.spyOn(storage, "saveBatch")
    await expect(backend.store(tree, [record(1)])).rejects.toThrow()
    // The committed bytes return through native's recovery scan.
    expect(await next(iterator)).toMatchObject({
      type: "blobs",
      blobs: [record(1).blob],
    })
    const retry = await initial(backend.open(tree))
    expect(retry.records).toEqual([record(1)])
    const writes = savedKeys(save).filter(key =>
      key.includes("/commits/")
    ).length
    await backend.store(tree, [record(1)])
    expect(await next(retry.iterator)).toMatchObject({
      type: "records",
      phase: "live",
      records: [record(1)],
    })
    expect(
      savedKeys(save).filter(key => key.includes("/commits/"))
    ).toHaveLength(writes)
    await retry.iterator.return!()
    expect((await initial(backend.open(tree))).records).toEqual([record(1)])
    await expect(backend.flush()).rejects.toBeInstanceOf(AggregateError)
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

  it("flush captures work, drains failures, and is not held open by later writes", async () => {
    const backend = create()
    const first = deferred(),
      second = deferred(),
      enteredFirst = deferred(),
      enteredSecond = deferred()
    storage.beforeSave = async key => {
      if (key.endsWith(`/meta/${cid(1)}`)) {
        enteredFirst.resolve()
        await first.promise
      }
      if (key.endsWith(`/meta/${cid(2)}`)) {
        enteredSecond.resolve()
        await second.promise
      }
    }
    const a = backend.store(tree, [record(1)])
    await enteredFirst.promise
    const flush = backend.flush()
    const b = backend.store(tree, [record(2)])
    first.resolve()
    await flush
    await a
    await enteredSecond.promise
    let done = false
    void b.then(() => {
      done = true
    })
    expect(done).toBe(false)
    second.resolve()
    await b
  })

  it("fences deletion immediately, drains earlier writes, and allows later reacquisition", async () => {
    const backend = create()
    const { iterator } = await initial(backend.open(tree))
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
    expect(await next(iterator)).toMatchObject({ type: "deleted" })
    expect((await iterator.next()).done).toBe(true)
    await expect(backend.store(tree, [record(2)])).rejects.toMatchObject({
      code: "deleted",
    })
    gate.resolve()
    await writing
    await deleting
    expect(await storage.list("subduction-v2/")).toEqual([])
    expect((await initial(backend.open(tree))).complete.found).toBe(false)
    await backend.store(tree, [record(2)])
    expect((await initial(backend.open(tree))).records).toEqual([record(2)])
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

  it("flush drains every captured attempt before reporting an earlier failure", async () => {
    const backend = create()
    const gate = deferred(),
      entered = deferred()
    storage.beforeSave = async key => {
      if (key.endsWith(`/meta/${cid(1)}`)) throw new Error("first failed")
      if (key.endsWith(`/meta/${cid(2)}`)) {
        entered.resolve()
        await gate.promise
      }
    }
    const first = backend.store(tree, [record(1)]).catch(() => {})
    const second = backend.store(tree, [record(2)])
    const captured = backend.flush()
    let reported = false
    const failure = captured.catch(cause => {
      reported = true
      return cause
    })
    await first
    await entered.promise
    expect(reported).toBe(false)
    gate.resolve()
    await second
    const aggregate = await failure
    expect(aggregate).toBeInstanceOf(AggregateError)
    // Local submissions and native storage callbacks have independent ledgers;
    // the same I/O failure may be represented in both. Neither may be forgotten
    // or reported again by the next barrier.
    const failures = aggregate.errors.flatMap((error: unknown) =>
      error instanceof AggregateError ? error.errors : [error]
    )
    expect(failures.map(String)).toContainEqual(
      expect.stringContaining("first failed")
    )
    await backend.flush()
  })

  it("pins bounded initial batches independently of replay and allows immediate return during blocked acquisition", async () => {
    const backend = create({ replayEvents: 1 })
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

  it("rejects different same-key variants without acknowledging discarded history", async () => {
    const backend = create()
    await backend.store(tree, [record(1)])
    await expect(
      backend.store(tree, [{ ...record(1), blob: new Uint8Array([8]) }])
    ).rejects.toMatchObject({ code: "conflict" })
    expect((await initial(backend.open(tree))).records).toEqual([record(1)])
  })
})
