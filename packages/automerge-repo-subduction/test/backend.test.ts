// Node fullfat initializes the SAME runtime used by implementation's slim import.
import * as N from "@automerge/subduction"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
import { DiskStore, deferred } from "./storage.js"

const tree = sedimentreeId("ab".repeat(16))
const cid = (n: number) => commitId(n.toString(16).padStart(64, "0"))
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
    if (result.done) throw new Error("Missing local load checkpoint")
    if (result.value.type === "failure") throw result.value.error
    if (result.value.type === "records")
      records.push(...(result.value.records as LooseCommitRecord[]))
    if (result.value.type === "local-load-complete")
      return { records, complete: result.value, iterator }
  }
}
async function next(iterator: AsyncIterator<SedimentreeEvent>) {
  const value = await iterator.next()
  if (value.done) throw new Error("Unexpected end")
  return value.value
}

describe("real local Subduction", () => {
  let root: string, storage: DiskStore, signer: N.MemorySigner
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
    root = await mkdtemp(join(tmpdir(), "repo-subduction-"))
    storage = new DiskStore(root)
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
    await rm(root, { recursive: true, force: true })
  })

  it("mints distinct IDs and stores initial history before returning", async () => {
    const backend = create()
    const first = await backend.create([record(1)])
    const second = await backend.create([record(1)])
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(second).not.toBe(first)
    expect((await initial(backend.open(first))).records).toEqual([record(1)])
    expect((await initial(backend.open(second))).records).toEqual([record(1)])
    await expect(backend.create([])).rejects.toMatchObject({
      operation: "create",
      code: "invalid-record",
    })
  })

  it("accepts backend-only IDs and rejects concurrent creation without merging or poisoning flush", async () => {
    const backend = create()
    const full = sedimentreeId("cd".repeat(32))
    for (const id of [tree, full]) {
      const empty = backend.open(id)
      await initial(empty)
      await empty.close()
      const first = backend.create([record(1)], { documentId: id })
      const second = backend.create([record(2)], { documentId: id })
      await expect(first).resolves.toBe(id)
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
    ).rejects.toThrow(TypeError)
  })

  it("persists native signed bytes, opaque commit identities and parents; reloads through a fresh engine", async () => {
    const backend = create()
    await backend.store(tree, [record(2, [1]), record(1)])
    const keys = await storage.list("subduction-v1/")
    const key = keys.find(k => k.endsWith(`/commits/${cid(2)}`))!
    const frame = JSON.parse(new TextDecoder().decode(await storage.load(key)))
    const signed = N.SignedLooseCommit.tryDecode(
      Uint8Array.from(Buffer.from(frame.signed, "hex"))
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
    const reload = create()
    const loaded = await initial(reload.open(tree))
    expect(hydration).toHaveBeenCalledOnce()
    // The actual native reload (not just the bridge snapshot) found both commits.
    await expect(hydration.mock.results[0].value).resolves.toHaveLength(2)
    expect(loaded.records).toEqual([record(1), record(2, [1])])
    expect(loaded.complete.checkpoint.heads).toEqual([cid(2)])
    const collection = reload.observeCollection()[Symbol.asyncIterator]()
    expect((await collection.next()).value).toMatchObject({
      type: "document",
      id: tree,
      phase: "initial",
    })
    expect((await collection.next()).value).toMatchObject({
      type: "local-load-complete",
    })
    await collection.return!()
  })

  it.each(["before", "after"])(
    "delivers an exact native duplicate written externally %s watch installation",
    async timing => {
      const a = create()
      if (timing === "before") await a.store(tree, [record(1)])
      const b = create()
      const loaded = await initial(b.open(tree))
      expect(loaded.records).toEqual(timing === "before" ? [record(1)] : [])
      const collection = b.observeCollection()[Symbol.asyncIterator]()
      if (timing === "before") await collection.next()
      expect((await collection.next()).value).toMatchObject({
        type: "local-load-complete",
      })
      if (timing === "after") await a.store(tree, [record(1)])
      // Sequential external writes test notification recovery, not shared ownership.
      const save = vi.spyOn(storage, "save")
      const hydration = vi.spyOn(N.Subduction.prototype, "getCommits")
      await b.store(tree, [record(1)])
      expect(await next(loaded.iterator)).toMatchObject({
        type: "records",
        phase: "live",
        records: [record(1)],
      })
      expect(await next(loaded.iterator)).toMatchObject({
        type: "checkpoint",
        checkpoint: { heads: [cid(1)] },
      })
      expect((await collection.next()).value).toMatchObject({
        type: "document",
        phase: "live",
        id: tree,
      })
      expect(
        save.mock.calls.filter(([key]) => key.includes("/commits/"))
      ).toEqual([])
      expect((await initial(b.open(tree))).records).toEqual([record(1)])
      expect(hydration).toHaveBeenCalledOnce()
      await expect(hydration.mock.results[0].value).resolves.toHaveLength(1)
      await loaded.iterator.return!()
      await collection.return!()
    }
  )

  it("bounds repeated durable duplicate notifications with rescan-required", async () => {
    const backend = create({ replayEvents: 2 })
    await backend.store(tree, [record(1)])
    const { iterator } = await initial(backend.open(tree))
    const save = vi.spyOn(storage, "save")
    for (let i = 0; i < 3; i++) await backend.store(tree, [record(1)])
    expect(await next(iterator)).toMatchObject({ type: "rescan-required" })
    expect((await iterator.next()).done).toBe(true)
    expect(
      save.mock.calls.filter(([key]) => key.includes("/commits/"))
    ).toEqual([])
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
    expect((await initial(backend.open(full))).records).toEqual([record(2)])
  })

  it("reserves a finite initial cut at call time and copies inputs before await", async () => {
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
    expect(loaded.records).toEqual([record(1)])
    const live = await next(loaded.iterator)
    expect(live).toMatchObject({
      type: "records",
      phase: "live",
      records: [record(2, [1])],
    })
    if (live.type === "records") live.records[0].blob.fill(0)
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
    expect((await next(iterator)).type).toBe("records")
    expect(await next(iterator)).toMatchObject({
      type: "checkpoint",
      checkpoint: { heads: [cid(1)] },
    })
    expect(await next(iterator)).toMatchObject({
      type: "synchronized",
      result: { outcome: "no-peers", checkpoint: { heads: [cid(1)] } },
    })
    const pending = iterator.next()
    await iterator.return!()
    expect((await pending).done).toBe(true)
    await expect(session.synchronize()).rejects.toMatchObject({
      code: "closed",
    })
  })

  it("has no total-history cap: a tree grown past any old budget reopens, enumerates and deletes", async () => {
    // Small budget in a fresh backend. Writes are never refused for tree size.
    const backend = create({ maxBatchBytes: 4096, batchRecords: 8 })
    for (let n = 1; n <= 40; n++)
      await backend.store(tree, [record(n, n > 1 ? [n - 1] : [])])
    await backend.close()
    const reopened = create()
    const loaded = await initial(reopened.open(tree))
    expect(loaded.records).toHaveLength(40)
    expect(loaded.complete.checkpoint.heads).toEqual([cid(40)])
    const collection = reopened.observeCollection()[Symbol.asyncIterator]()
    expect((await collection.next()).value).toMatchObject({
      type: "document",
      id: tree,
    })
    await collection.return!()
    await reopened.deleteLocal(tree)
    expect(await storage.list("subduction-v1/")).toEqual([])
  })

  it("stores with constant storage work and no checkpoint rescans once complete", async () => {
    const backend = create()
    await backend.store(tree, [record(1)])
    const session = backend.open(tree)
    const { iterator } = await initial(session)
    session.markComplete!()
    const list = vi.spyOn(storage, "list")
    const load = vi.spyOn(storage, "load")
    await backend.store(tree, [record(2, [1])])
    expect(await next(iterator)).toMatchObject({
      type: "records",
      records: [record(2, [1])],
    })
    // Sync-round checkpoints come from delivered heads, not a storage reread.
    await session.synchronize()
    expect(await next(iterator)).toMatchObject({
      type: "synchronized",
      result: { outcome: "no-peers", checkpoint: { heads: [cid(2)] } },
    })
    expect(list).not.toHaveBeenCalled()
    expect(load.mock.calls.map(([key]) => key)).toEqual([
      `subduction-v1/${tree.padEnd(64, "0")}/commits/${cid(2)}`,
    ])
    // Readers still validate the authoritative stored history.
    expect((await initial(backend.open(tree))).records).toEqual([
      record(1),
      record(2, [1]),
    ])
  })

  it("keeps emitting storage checkpoints while any session on the tree is incomplete", async () => {
    const backend = create()
    const done = backend.open(tree)
    const loading = backend.open(tree)
    const a = await initial(done)
    const b = await initial(loading)
    done.markComplete!()
    await backend.store(tree, [record(1)])
    for (const { iterator } of [a, b]) {
      expect((await next(iterator)).type).toBe("records")
      expect(await next(iterator)).toMatchObject({
        type: "checkpoint",
        checkpoint: { heads: [cid(1)] },
      })
    }
    // The incomplete session can still become ready from live data; once it is
    // also complete, checkpoints stop for the whole tree.
    loading.markComplete!()
    const list = vi.spyOn(storage, "list")
    await backend.store(tree, [record(2, [1])])
    expect((await next(a.iterator)).type).toBe("records")
    await done.synchronize()
    expect(await next(a.iterator)).toMatchObject({
      type: "synchronized",
      result: { checkpoint: { heads: [cid(2)] } },
    })
    expect(list).not.toHaveBeenCalled()
  })

  it("reopening after a session closes seeds delivered heads from storage", async () => {
    const backend = create()
    await backend.store(tree, [record(1), record(2, [1])])
    const first = backend.open(tree)
    await initial(first)
    first.markComplete!()
    await first.close()
    const second = backend.open(tree)
    const { iterator, complete } = await initial(second)
    expect(complete.checkpoint.heads).toEqual([cid(2)])
    second.markComplete!()
    await backend.store(tree, [record(3, [2])])
    expect((await next(iterator)).type).toBe("records")
    await second.synchronize()
    expect(await next(iterator)).toMatchObject({
      type: "synchronized",
      result: { checkpoint: { heads: [cid(3)] } },
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
      `subduction-v1/${tree.padEnd(64, "0")}/fragments/${cid(1)}`,
      new Uint8Array([1])
    )
    const iterator = backend.open(tree).events[Symbol.asyncIterator]()
    expect(await next(iterator)).toMatchObject({
      type: "failure",
      error: { code: "io" },
    })
    expect((await iterator.next()).done).toBe(true)
    const collection = backend.observeCollection()[Symbol.asyncIterator]()
    expect((await collection.next()).value).toMatchObject({
      type: "failure",
      error: { code: "io" },
    })
    await expect(backend.deleteLocal(tree)).rejects.toThrow()
    expect(await storage.list("subduction-v1/")).toHaveLength(1)
  })

  it.each(["malformed", "blob", "key", "tree", "signed"])(
    "fails loudly on persisted %s corruption",
    async kind => {
      const backend = create()
      await backend.store(tree, [record(1)])
      await backend.close()
      const key = (await storage.list("subduction-v1/")).find(k =>
        k.includes("/commits/")
      )!
      const frame = JSON.parse(
        new TextDecoder().decode(await storage.load(key))
      )
      if (kind === "blob") frame.blob = "ffff"
      if (kind === "signed")
        frame.signed =
          frame.signed.slice(0, -2) +
          (frame.signed.endsWith("00") ? "ff" : "00")
      if (kind === "key") frame.commit = cid(2)
      if (kind === "tree") {
        // Changing envelope AND key cannot launder the native signed tree ID.
        const other = "cc".repeat(32)
        frame.tree = other
        await storage.remove(key)
        await storage.save(
          key.replace(tree.padEnd(64, "0"), other),
          new TextEncoder().encode(JSON.stringify(frame))
        )
        const stream = create()
          .open(sedimentreeId(other))
          .events[Symbol.asyncIterator]()
        expect(await next(stream)).toMatchObject({ type: "failure" })
        return
      }
      await storage.save(
        key,
        new TextEncoder().encode(
          kind === "malformed" ? "not JSON" : JSON.stringify(frame)
        )
      )
      const iterator = create().open(tree).events[Symbol.asyncIterator]()
      expect(await next(iterator)).toMatchObject({ type: "failure" })
      expect((await iterator.next()).done).toBe(true)
    }
  )

  it("rescans partial persisted saves, reports historical failure to flush, and retries safely", async () => {
    const backend = create()
    const { iterator } = await initial(backend.open(tree))
    let count = 0
    storage.beforeSave = async key => {
      if (key.includes("/commits/") && ++count === 2)
        throw new Error("disk failed")
    }
    await expect(backend.store(tree, [record(1), record(2)])).rejects.toThrow()
    expect(await next(iterator)).toMatchObject({ type: "rescan-required" })
    expect((await iterator.next()).done).toBe(true)
    expect((await initial(backend.open(tree))).records).toEqual([record(1)])
    await expect(backend.flush()).rejects.toBeInstanceOf(AggregateError)
    storage.beforeSave = undefined
    await backend.store(tree, [record(1), record(2)])
    expect((await initial(backend.open(tree))).records).toEqual([
      record(1),
      record(2),
    ])
    await backend.flush()
  })

  it("recovers record and collection observations when save commits bytes but then rejects", async () => {
    const backend = create()
    const { iterator } = await initial(backend.open(tree))
    const collection = backend.observeCollection()[Symbol.asyncIterator]()
    await collection.next()
    const save = storage.save.bind(storage)
    let fail = true
    vi.spyOn(storage, "save").mockImplementation(async (key, value) => {
      await save(key, value)
      if (key.includes("/commits/") && fail) {
        fail = false
        throw new Error("ambiguous write outcome")
      }
    })
    await expect(backend.store(tree, [record(1)])).rejects.toThrow()
    expect(await next(iterator)).toMatchObject({ type: "rescan-required" })
    expect((await collection.next()).value).toMatchObject({
      type: "rescan-required",
    })
    const retry = await initial(backend.open(tree))
    expect(retry.records).toEqual([record(1)])
    const writes = vi
      .mocked(storage.save)
      .mock.calls.filter(([key]) => key.includes("/commits/")).length
    await backend.store(tree, [record(1)])
    expect(await next(retry.iterator)).toMatchObject({
      type: "records",
      phase: "live",
      records: [record(1)],
    })
    expect(
      vi
        .mocked(storage.save)
        .mock.calls.filter(([key]) => key.includes("/commits/"))
    ).toHaveLength(writes)
    await retry.iterator.return!()
    expect((await initial(backend.open(tree))).records).toEqual([record(1)])
    const fresh = backend.observeCollection()[Symbol.asyncIterator]()
    expect((await fresh.next()).value).toMatchObject({
      type: "document",
      id: tree,
    })
    await fresh.return!()
    await expect(backend.flush()).rejects.toBeInstanceOf(AggregateError)
  })

  it("filters phantom ID markers from collection enumeration", async () => {
    const backend = create()
    storage.beforeSave = async key => {
      if (key.includes("/commits/")) throw new Error("disk failed")
    }
    await expect(backend.store(tree, [record(1)])).rejects.toThrow()
    const iterator = backend.observeCollection()[Symbol.asyncIterator]()
    expect((await iterator.next()).value).toMatchObject({
      type: "local-load-complete",
    })
    await iterator.return!()
  })

  it("flush captures work, drains failures, and is not held open by later writes", async () => {
    const backend = create()
    const first = deferred(),
      second = deferred(),
      enteredFirst = deferred(),
      enteredSecond = deferred()
    storage.beforeSave = async key => {
      if (key.endsWith(`/commits/${cid(1)}`)) {
        enteredFirst.resolve()
        await first.promise
      }
      if (key.endsWith(`/commits/${cid(2)}`)) {
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
    expect(await storage.list("subduction-v1/")).toEqual([])
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

  it("collection cut excludes later writes without losing live activity", async () => {
    const backend = create()
    const collection = backend.observeCollection()[Symbol.asyncIterator]()
    await backend.store(tree, [record(1)])
    expect((await collection.next()).value).toMatchObject({
      type: "local-load-complete",
    })
    expect((await collection.next()).value).toMatchObject({
      type: "document",
      phase: "live",
      id: tree,
    })
    const pending = collection.next()
    await collection.return!()
    expect((await pending).done).toBe(true)
  })

  it("flush drains every captured attempt before reporting an earlier failure", async () => {
    const backend = create()
    const gate = deferred(),
      entered = deferred()
    storage.beforeSave = async key => {
      if (key.endsWith(`/commits/${cid(1)}`)) throw new Error("first failed")
      if (key.endsWith(`/commits/${cid(2)}`)) {
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
    const backend = create({ batchRecords: 1, replayEvents: 1 })
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
