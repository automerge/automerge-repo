// Node fullfat initializes the SAME runtime used by implementation's slim import.
import * as N from "@automerge/subduction"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  BackendError,
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
import { Watch } from "../src/watch.js"
import { TestStore, deferred, savedKeys } from "./storage.js"
import { corruptFrame } from "./frame.js"
import type { TestSigner } from "./transport.js"
import { nodeOf } from "./native.js"

const tree = sedimentreeId("ab".repeat(16) + "00".repeat(16))
const somePeer = "cd".repeat(32)
/** Not a fragment boundary: no leading zero byte. */
const cid = (n: number) => commitId("f" + n.toString(16).padStart(63, "0"))
const record = (n: number, parents: number[] = []): LooseCommitRecord => ({
  kind: "commit",
  id: cid(n),
  parents: parents.map(cid),
  blob: new Uint8Array([n, 42]),
})
async function initial(session: SedimentreeSession) {
  const iterator = session.events[Symbol.asyncIterator]()
  const records: LooseCommitRecord[] = []
  for (;;) {
    const result = await iterator.next()
    if (result.done) throw new Error("Missing local load marker")
    if (result.value.type === "failure") throw result.value.error
    if (result.value.type === "records") {
      expect(result.value.phase).toBe("initial")
      records.push(...(result.value.records as LooseCommitRecord[]))
    }
    if (result.value.type === "local-load-complete") {
      const complete = result.value
      const confirmed = complete.found
        ? undefined
        : await confirmation(iterator)
      return { records, complete, confirmed, iterator }
    }
  }
}
/** An empty first load is settled by one confirmation round. */
async function confirmation(iterator: AsyncIterator<SedimentreeEvent>) {
  let event = await next(iterator)
  // Peer notifications may arrive first; nothing else should.
  while (event.type === "remote-heads" || event.type === "ephemeral")
    event = await next(iterator)
  if (event.type !== "synchronized")
    throw new Error(`Expected a confirmation round, got ${event.type}`)
  return event.result
}
/** Loose commits native holds for `tree`, hydrating on demand. */
async function nativeCommits(backend: SubductionBackend): Promise<number> {
  return ((await nodeOf(backend).getCommits(tree)) ?? []).length
}
async function next(iterator: AsyncIterator<SedimentreeEvent>) {
  const value = await iterator.next()
  if (value.done) throw new Error("Unexpected end")
  return value.value
}
async function until<K extends SedimentreeEvent["type"]>(
  iterator: AsyncIterator<SedimentreeEvent>,
  type: K
): Promise<Extract<SedimentreeEvent, { type: K }>> {
  for (;;) {
    const event = await next(iterator)
    if (event.type === type)
      return event as Extract<SedimentreeEvent, { type: K }>
  }
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
    expect(second).toMatch(/^[0-9a-f]{64}$/)
    expect(second).not.toBe(first)
    expect((await initial(backend.open(first))).records).toEqual([record(1)])
    expect((await initial(backend.open(second))).records).toEqual([record(1)])
    await expect(backend.create([])).rejects.toMatchObject({
      operation: "create",
      code: "invalid-record",
    })
  })

  it("mints IDs with the mintDocumentId hook, given the initial records", async () => {
    const keyhive = sedimentreeId("cd".repeat(32))
    const mintDocumentId = vi.fn(() => Buffer.from(keyhive, "hex"))
    const backend = create({ mintDocumentId })
    const id = await backend.create([record(1)])
    expect(id).toBe(keyhive)
    expect(mintDocumentId).toHaveBeenCalledWith([record(1)])
    expect((await initial(backend.open(id))).records).toEqual([record(1)])
    // A supplied ID bypasses the hook.
    const supplied = sedimentreeId("ef".repeat(16) + "00".repeat(16))
    await expect(
      backend.create([record(1)], { documentId: supplied })
    ).resolves.toBe(supplied)
    expect(mintDocumentId).toHaveBeenCalledTimes(1)
  })

  it("checks for an existing document only when the ID could collide", async () => {
    const backend = create()
    const engine = nodeOf(backend)
    const reads = vi.spyOn(engine, "getHeads")
    await backend.create([record(1)])
    expect(reads).not.toHaveBeenCalled()
    await backend.create([record(1)], { documentId: tree })
    expect(reads).toHaveBeenCalledOnce()
  })

  it("rejects a custom-minted ID that already holds records", async () => {
    const backend = create({
      mintDocumentId: () => Buffer.from(tree, "hex"),
    })
    await expect(backend.create([record(1)])).resolves.toBe(tree)
    await expect(backend.create([record(2)])).rejects.toMatchObject({
      operation: "create",
      code: "conflict",
    })
    expect((await initial(backend.open(tree))).records).toEqual([record(1)])
  })

  it("snapshots create input before an async mint", async () => {
    const keyhive = sedimentreeId("cd".repeat(32))
    const backend = create({
      mintDocumentId: async () => Buffer.from(keyhive, "hex"),
    })
    const input = [record(1)]
    const pending = backend.create(input)
    ;(input[0].blob as Uint8Array).fill(0)
    input.push(record(2))
    const id = await pending
    expect((await initial(backend.open(id))).records).toEqual([record(1)])
  })

  it.each([
    ["returns a wrong length", () => new Uint8Array(16)],
    [
      "throws",
      () => {
        throw new Error("no keyhive")
      },
    ],
    ["rejects", () => Promise.reject(new Error("no keyhive"))],
  ])("rejects create when mintDocumentId %s", async (_, mintDocumentId) => {
    const backend = create({ mintDocumentId })
    await expect(backend.create([record(1)])).rejects.toMatchObject({
      name: "BackendError",
      operation: "create",
      code: "invalid-id",
    })
    await expect(backend.flush()).resolves.toBeUndefined()
  })

  /** Hold this store's first scan of `id` until released. */
  function blockScan(id = tree) {
    const entered = deferred(),
      release = deferred()
    const load = storage.loadPrefix.bind(storage)
    const scan = `subduction-v2/trees/${id}/`
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

  it("passes the sync timeout to Subduction, which validates it", async () => {
    expect(() => create({ syncTimeoutMilliseconds: -1 })).toThrow(TypeError)
    expect(() => create({ syncTimeoutMilliseconds: 1.5 })).toThrow(TypeError)
    const backend = create({ syncTimeoutMilliseconds: 1234 })
    const engine = nodeOf(backend)
    const rounds = vi.spyOn(engine, "syncWithAllPeers")
    await initial(backend.open(tree))
    // Rounds skip native without a connected peer.
    vi.spyOn(engine, "getConnectedPeerIds").mockResolvedValue([somePeer])
    await backend.store(tree, [record(1)])
    await vi.waitFor(() => expect(rounds).toHaveBeenCalled())
    // Rounds rely on the node's default deadline.
    expect(rounds.mock.calls[0][1]).toEqual({ subscribe: true })
  })

  it("opens via a native stored stream", async () => {
    const backend = create()
    await backend.store(tree, [record(1)])
    const native = vi.spyOn(nodeOf(backend), "loadAndWatch")
    const loaded = await initial(backend.open(tree))
    expect(native).toHaveBeenCalledOnce()
    expect(loaded.records).toEqual([record(1)])
    expect(loaded.complete).toMatchObject({
      found: true,
      marker: { heads: [cid(1)] },
    })
  })

  it("passes each scanned item on as its own initial record, then the scanned heads", async () => {
    const backend = create()
    const records = [record(1), record(2, [1]), record(3, [2])]
    await backend.store(tree, records)
    const iterator = backend.open(tree).events[Symbol.asyncIterator]()
    const events: SedimentreeEvent[] = []
    for (;;) {
      const event = await next(iterator)
      events.push(event)
      if (event.type === "local-load-complete") break
    }
    expect(events.map(event => event.type)).toEqual([
      "records",
      "records",
      "records",
      "local-load-complete",
    ])
    for (const event of events.slice(0, 3))
      expect(event).toMatchObject({
        phase: "initial",
        records: [expect.anything()],
      })
    expect(
      events.flatMap(event => (event.type === "records" ? event.records : []))
    ).toEqual(expect.arrayContaining(records))
    expect(events.at(-1)).toMatchObject({ marker: { heads: [cid(3)] } })
  })

  it("delivers record bytes isolated between sessions", async () => {
    const backend = create()
    await backend.store(tree, [record(1)])
    const first = await initial(backend.open(tree))
    const second = await initial(backend.open(tree))
    expect(first.records[0].blob).not.toBe(second.records[0].blob)
    first.records[0].blob.fill(0)
    expect(second.records).toEqual([record(1)])
    expect((await initial(backend.open(tree))).records).toEqual([record(1)])
  })

  it("starts unrelated opens while another initial scan is pending", async () => {
    const backend = create()
    const otherTree = sedimentreeId("cd".repeat(16) + "00".repeat(16))
    const scan = blockScan()
    const first = backend.open(tree)
    await scan.entered
    const other = await initial(backend.open(otherTree))
    expect(other.complete.found).toBe(false)
    scan.release()
    expect((await initial(first)).complete.found).toBe(false)
    await backend.close()
  })

  it("closes while an initial scan is pending", async () => {
    const backend = create()
    const engine = nodeOf(backend)
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
    const otherTree = sedimentreeId("cd".repeat(16) + "00".repeat(16))
    const other = await initial(backend.open(otherTree))
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
    while (event.type !== "records") event = await next(other.iterator)
    expect(event.records[0].blob).toEqual(record(1).blob)
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

  it("delivers a save overlapping the initial scan without a gap", async () => {
    const backend = create()
    await backend.store(tree, [record(1)])
    const scan = blockScan()
    const session = backend.open(tree)
    await scan.entered
    const write = backend.store(tree, [record(2, [1])])
    scan.release()
    const loaded = await initial(session)
    await write
    // Native may fold the save into the scan or deliver it live after.
    if (loaded.records.length < 2)
      expect(await next(loaded.iterator)).toMatchObject({
        type: "records",
        phase: "live",
        records: [record(2, [1])],
      })
    else expect(loaded.records).toEqual([record(1), record(2, [1])])
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
      await initial(empty)
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
      expect((await initial(backend.open(id))).records).toEqual([record(1)])
      await backend.flush()
      await backend.deleteLocal(id)
      await expect(
        backend.create([record(2)], { documentId: id })
      ).resolves.toBe(id)
    }
    await expect(
      backend.create([record(1)], { documentId: "invalid" as typeof tree })
    ).rejects.toMatchObject({ operation: "create", code: "invalid-id" })
  })

  it("persists native signed bytes, opaque commit identities and parents; reloads through a fresh engine", async () => {
    const backend = create()
    await backend.store(tree, [record(2, [1]), record(1)])
    const keys = await storage.list("subduction-v2/")
    const key = keys.find(k => k.endsWith(`/signed/${cid(2)}`))!
    expect((await storage.load(key))!.length).toBeGreaterThan(0)
    const engine = nodeOf(backend)
    const commit = ((await engine.getCommits(tree)) ?? []).find(
      c => c.head === cid(2)
    )!
    expect(commit.parents).toEqual([cid(1)])
    expect(commit.head).not.toBe(commit.blobMeta.digest)
    expect((await initial(backend.open(tree))).records).toEqual([
      record(1),
      record(2, [1]),
    ])
    await backend.close()
    // Signer is borrowed and remains usable after backend close.
    expect((await signer.sign(new Uint8Array([1]))).length).toBe(64)
    const loadPrefix = vi.spyOn(storage, "loadPrefix")
    const reload = create()
    const hydration = vi.spyOn(nodeOf(reload), "getCommits")
    const loaded = await initial(reload.open(tree))
    // Native reads commits and fragments once each.
    expect(hydration).not.toHaveBeenCalled()
    expect(loadPrefix).toHaveBeenCalledTimes(2)
    expect(loaded.records).toEqual([record(1), record(2, [1])])
    expect(loaded.complete.marker).toMatchObject({ heads: [cid(2)] })
    // Native hydrates on demand from storage and finds both commits.
    await expect(nativeCommits(reload)).resolves.toBe(2)
  })

  it("converges on repeated duplicate stores", async () => {
    const backend = create()
    await backend.store(tree, [record(1)])
    const { iterator } = await initial(backend.open(tree))
    for (let i = 0; i < 3; i++) await backend.store(tree, [record(1)])
    await iterator.return!()
    expect((await initial(backend.open(tree))).records).toEqual([record(1)])
    await expect(nativeCommits(backend)).resolves.toBe(1)
  })

  it("passes 32-byte IDs to native unchanged and rejects other lengths", async () => {
    const full = sedimentreeId("ab".repeat(16) + "cd".repeat(16))
    const backend = create()
    const short = "ab".repeat(16) as typeof tree
    const invalid = { name: "BackendError", code: "invalid-id" }
    expect(() => backend.open(short)).toThrow(
      expect.objectContaining({ ...invalid, operation: "open" })
    )
    await expect(backend.store(short, [record(1)])).rejects.toMatchObject({
      ...invalid,
      operation: "store",
    })
    await expect(backend.flush([short])).rejects.toMatchObject({
      ...invalid,
      operation: "flush",
    })
    await expect(backend.deleteLocal(short)).rejects.toMatchObject({
      ...invalid,
      operation: "delete",
    })
    await backend.store(tree, [record(1)])
    await backend.store(full, [record(2)])
    expect((await initial(backend.open(tree))).records).toEqual([record(1)])
    expect((await initial(backend.open(full))).records).toEqual([record(2)])
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
    loaded.records.forEach(record => record.blob.fill(0))
    expect((await initial(backend.open(tree))).records).toEqual([
      record(1),
      record(2, [1]),
    ])
  })

  it("reports a local propagation failure as retryable", async () => {
    const backend = create()
    await backend.store(tree, [record(1)])
    const { iterator } = await initial(backend.open(tree))
    const engine = nodeOf(backend)
    // Rounds skip native without a connected peer.
    vi.spyOn(engine, "getConnectedPeerIds").mockResolvedValue([somePeer])
    vi.spyOn(engine, "syncWithAllPeers").mockRejectedValueOnce(
      new Error("ingest storage failed")
    )
    // A batch propagates by a round; single records are pushed natively.
    await backend.store(tree, [record(2, [1]), record(3, [2])])
    expect(await until(iterator, "failure")).toMatchObject({
      error: { operation: "synchronize", code: "io", retryable: true },
    })
    // The session keeps working after the failed round.
    await backend.store(tree, [record(4, [3])])
    // Records from the failed round's batch may still precede it.
    let live = await until(iterator, "records")
    while (live.records[0].id !== cid(4))
      live = await until(iterator, "records")
    expect(live.records).toEqual([record(4, [3])])
  })

  it("ends the watch after a nonretryable round failure, superseding queued events", async () => {
    const backend = create()
    const { iterator } = await initial(backend.open(tree))
    const engine = nodeOf(backend)
    vi.spyOn(engine, "getConnectedPeerIds").mockResolvedValue([somePeer])
    // The live record on an empty-loaded session starts a confirmation round;
    // a single record is pushed natively, not propagated.
    vi.spyOn(engine, "syncWithAllPeers").mockRejectedValue(
      new BackendError("synchronize", "unsupported", "fatal", false)
    )
    const finish = vi.spyOn(Watch.prototype, "finish")
    await backend.store(tree, [record(1)])
    // Pull only once the failure has ended the watch: the record queued
    // before it is superseded.
    await vi.waitFor(() =>
      expect(finish).toHaveBeenCalledWith(
        expect.objectContaining({ type: "failure" })
      )
    )
    expect(await next(iterator)).toMatchObject({
      type: "failure",
      error: { code: "unsupported", retryable: false },
    })
    expect((await iterator.next()).done).toBe(true)
  })

  it("settles an empty load without peers through a confirmation result, without a native round", async () => {
    const backend = create()
    const engine = nodeOf(backend)
    const rounds = vi.spyOn(engine, "syncWithAllPeers")
    const { complete, confirmed } = await initial(backend.open(tree))
    expect(complete).toEqual({
      type: "local-load-complete",
      marker: { sequence: expect.any(Number), heads: [] },
      found: false,
    })
    expect(confirmed).toMatchObject({
      outcome: "no-peers",
      peers: [],
      marker: { heads: [] },
    })
    expect(rounds).not.toHaveBeenCalled()
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
    const engine = nodeOf(backend)
    // With a peer reported connected, a scheduled round would reach native.
    vi.spyOn(engine, "getConnectedPeerIds").mockResolvedValue([somePeer])
    const rounds = vi.spyOn(engine, "syncWithAllPeers")
    await expect(backend.store(tree, records)).rejects.toThrow()
    // A failed batch stored nothing, so no round propagates it.
    expect(rounds).not.toHaveBeenCalled()
    // Native recovers by rescanning: nothing of the failed batch surfaces.
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
    expect(reloaded.complete.marker).toMatchObject({ heads: [cid(10)] })
  })

  it("stores with constant storage work and no live marker rescans once ready", async () => {
    const backend = create()
    const engine = nodeOf(backend)
    const getHeads = vi.spyOn(engine, "getHeads")
    await backend.store(tree, [record(1)])
    const session = backend.open(tree)
    const { iterator } = await initial(session)
    session.markReady()
    const list = vi.spyOn(storage, "list")
    const load = vi.spyOn(storage, "loadMany")
    await backend.store(tree, [record(2, [1])])
    expect(await next(iterator)).toMatchObject({
      type: "records",
      records: [record(2, [1])],
    })
    expect(list).not.toHaveBeenCalled()
    expect(getHeads).not.toHaveBeenCalled()
    // The bridge does no preflight reads.
    expect(load).not.toHaveBeenCalled()
    // Readers still validate the authoritative stored history.
    expect((await initial(backend.open(tree))).records).toEqual([
      record(1),
      record(2, [1]),
    ])
  })

  it("emits storage markers only to sessions not yet ready", async () => {
    const backend = create()
    await backend.store(tree, [record(1)])
    const done = backend.open(tree)
    const loading = backend.open(tree)
    const a = await initial(done)
    const b = await initial(loading)
    done.markReady()
    await backend.store(tree, [record(2, [1])])
    expect(await next(a.iterator)).toMatchObject({ type: "records" })
    expect(await next(b.iterator)).toMatchObject({ type: "records" })
    expect(await next(b.iterator)).toMatchObject({
      type: "history-marker",
      marker: { heads: [cid(2)] },
    })
    await backend.store(tree, [record(3, [2])])
    expect(await next(a.iterator)).toMatchObject({
      type: "records",
      records: [record(3, [2])],
    })
  })

  it("waits past a delayed save before publishing native heads to a session not yet ready", async () => {
    const backend = create()
    await backend.store(tree, [record(1)])
    const { iterator } = await initial(backend.open(tree))
    const engine = nodeOf(backend)
    const native = tree
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

  it("reopening after a session closes reloads records and keeps observing", async () => {
    const backend = create()
    await backend.store(tree, [record(1), record(2, [1])])
    const first = backend.open(tree)
    await initial(first)
    first.markReady()
    await first.close()
    const second = backend.open(tree)
    const { iterator, complete } = await initial(second)
    expect(complete.marker).toMatchObject({ heads: [cid(2)] })
    second.markReady()
    await backend.store(tree, [record(3, [2])])
    expect(await next(iterator)).toMatchObject({
      type: "records",
      records: [record(3, [2])],
    })
  })

  it("reports malformed persisted fragments rather than treating them as absent", async () => {
    const backend = create()
    await storage.save(
      `subduction-v2/trees/${tree}/fragments/signed/${cid(1)}`,
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
      type: "records",
      phase: "live",
      records: [record(1)],
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

  it("registers a single record's tree only once the record is durable", async () => {
    const backend = create()
    storage.beforeSave = async key => {
      if (key.includes("/commits/")) throw new Error("disk failed")
    }
    await expect(backend.store(tree, [record(1)])).rejects.toThrow()
    expect(await storage.list("subduction-v2/ids/")).toEqual([])
  })

  it("enumerates a registered tree even if its batch fails", async () => {
    const backend = create()
    storage.beforeSave = async key => {
      if (key.includes("/commits/")) throw new Error("disk failed")
    }
    await expect(
      backend.store(tree, [record(1), record(2, [1])])
    ).rejects.toThrow()
    expect(await storage.list("subduction-v2/ids/")).toEqual([
      `subduction-v2/ids/${tree}`,
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
    // A stored, resident tree, as for edits to an open document.
    await backend.store(tree, [record(0)])
    const gate = deferred(),
      entered = deferred()
    storage.beforeSave = async key => {
      if (key.endsWith(`/signed/${cid(1)}`)) {
        entered.resolve()
        await gate.promise
        throw new Error("disk failed")
      }
    }
    const first = backend.store(tree, [record(1, [0])]).catch(e => e)
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
    const otherTree = sedimentreeId("cd".repeat(16) + "00".repeat(16))
    await backend.store(tree, [record(1)])
    const gate = deferred()
    const engine = nodeOf(backend)
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
    vi.spyOn(nodeOf(backend), "removeSedimentree").mockRejectedValueOnce(
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
