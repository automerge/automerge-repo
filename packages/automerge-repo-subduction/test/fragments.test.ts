// Fullfat initializes the runtime used by the backend's slim imports.
import * as N from "@automerge/subduction"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  checkpointForCommit,
  commitId,
  copyRecord,
  recordBytes,
  sedimentreeId,
  type FragmentRecord,
  type LooseCommitRecord,
  type SedimentreeEvent,
  type SedimentreeRecord,
} from "@automerge/automerge-repo/sedimentree"
import {
  SubductionBackend,
  type LocalByteStore,
  type SubductionBackendOptions,
} from "../src/index.js"
import { nativeId } from "../src/storage.js"
import { DiskStore, deferred } from "./storage.js"

const tree = sedimentreeId("ab".repeat(16))
const cid = (n: number) => commitId(n.toString(16).padStart(2, "0").repeat(32))
const loose = (n: number, parents: number[] = []): LooseCommitRecord => ({
  kind: "commit",
  id: cid(n),
  parents: parents.map(cid),
  blob: new Uint8Array([n, 42]),
})
const fragment = (n: number): FragmentRecord => ({
  kind: "fragment",
  head: cid(n),
  boundary: [cid(1)],
  checkpoints: [checkpointForCommit(cid(2)), checkpointForCommit(cid(3))],
  blob: new Uint8Array([n, 255, 128, 0]),
})
async function next(iterator: AsyncIterator<SedimentreeEvent>) {
  const result = await iterator.next()
  if (result.done) throw new Error("Unexpected end")
  return result.value
}
async function initial(backend: SubductionBackend) {
  const iterator = backend.open(tree).events[Symbol.asyncIterator]()
  const records: SedimentreeRecord[] = []
  for (;;) {
    const event = await next(iterator)
    if (event.type === "failure") throw event.error
    if (event.type === "records") records.push(...event.records)
    if (event.type === "local-load-complete")
      return { records, event, iterator }
  }
}

describe("local Subduction fragments", () => {
  let root: string, storage: DiskStore, signer: N.MemorySigner
  let backends: SubductionBackend[]
  function create(limits: Partial<SubductionBackendOptions> = {}) {
    const backend = new SubductionBackend({
      signer,
      storage,
      ...limits,
    })
    backends.push(backend)
    return backend
  }
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "repo-fragments-"))
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

  it("retains full records across native minimization, including a commit and fragment with the same head", async () => {
    const backend = create()
    const records = [loose(1), loose(4, [1]), fragment(4)]
    await backend.store(tree, records)
    const saves = vi.spyOn(storage, "save")
    await backend.store(tree, records)
    // Exact retries may touch the ID marker, but must not rewrite records.
    expect(saves.mock.calls.filter(([key]) => !key.endsWith("/id"))).toEqual([])
    expect((await initial(backend)).records).toEqual(records)
    await backend.close()
    const reloaded = create()
    const loaded = await initial(reloaded)
    expect(loaded.records).toEqual(records)
    expect(loaded.event.checkpoint.heads).toEqual([cid(4)])
    // Native hydrates on demand (not at open) and reads the stored fragment.
    const engine = (reloaded as unknown as { engine: N.Subduction }).engine
    const native = nativeId(tree)
    try {
      const fragments = (await engine.getFragments(native)) ?? []
      expect(fragments).toHaveLength(1)
      fragments.forEach(f => f.free())
    } finally {
      native.free()
    }
    const collection = reloaded.observeCollection()[Symbol.asyncIterator]()
    expect((await collection.next()).value).toMatchObject({
      type: "document",
      id: tree,
    })
    await collection.return!()
    const key = (await storage.list("subduction-v1/")).find(k =>
      k.includes("/fragments/")
    )!
    const frame = JSON.parse(new TextDecoder().decode(await storage.load(key)))
    const signed = N.SignedFragment.tryDecode(Buffer.from(frame.signed, "hex"))
    const payload = signed.payload
    const checkpoints = payload.checkpoints
    const id = payload.sedimentreeId
    try {
      expect(
        checkpoints.map(c => Buffer.from(c.toBytes()).toString("hex"))
      ).toEqual(fragment(4).checkpoints)
      expect(Buffer.from(id.toBytes()).toString("hex")).toBe(
        tree.padEnd(64, "0")
      )
    } finally {
      checkpoints.forEach(c => c.free())
      id.free()
      payload.free()
      signed.free()
    }
  })

  it("copies mutable fragment inputs and isolates observer buffers; empty checkpoints also roundtrip", async () => {
    const backend = create()
    const a = await initial(backend),
      b = await initial(backend)
    const input = {
      ...fragment(4),
      boundary: [cid(1), cid(1)],
      checkpoints: [],
    }
    const expected = copyRecord(input)
    const storing = backend.store(tree, [input])
    input.blob.fill(0)
    input.boundary.length = 0
    await storing
    const first = await next(a.iterator),
      second = await next(b.iterator)
    expect(first).toMatchObject({ type: "records", records: [expected] })
    if (first.type === "records") first.records[0].blob.fill(0)
    expect(second).toMatchObject({ type: "records", records: [expected] })
    expect((await initial(backend)).records).toEqual([expected])
  })

  it.each(["blob", "boundary", "checkpoints"] as const)(
    "rejects conflicting fragment %s without losing the original",
    async field => {
      const backend = create()
      const original = fragment(4)
      await backend.store(tree, [original])
      const conflict = { ...original }
      if (field === "blob") conflict.blob = new Uint8Array([42])
      if (field === "boundary") conflict.boundary = []
      if (field === "checkpoints") conflict.checkpoints = []
      await expect(backend.store(tree, [conflict])).rejects.toMatchObject({
        code: "conflict",
      })
      expect((await initial(backend)).records).toEqual([original])
    }
  )

  // Tree/key relocation and blob damage are not re-checked on read (see the
  // native hydration test below for blobs).
  it.each(["signed", "kind"])(
    "detects persisted fragment %s corruption",
    async field => {
      const backend = create()
      await backend.store(tree, [fragment(4)])
      await backend.close()
      const key = (await storage.list("subduction-v1/")).find(k =>
        k.includes("/fragments/")
      )!
      const frame = JSON.parse(
        new TextDecoder().decode(await storage.load(key))
      )
      if (field === "signed")
        frame.signed =
          frame.signed.slice(0, -2) +
          (frame.signed.endsWith("00") ? "ff" : "00")
      if (field === "kind") frame.kind = "commit"
      await storage.save(key, new TextEncoder().encode(JSON.stringify(frame)))
      const reloaded = create()
      const stream = reloaded.open(tree).events[Symbol.asyncIterator]()
      expect(await next(stream)).toMatchObject({ type: "failure" })
      expect((await stream.next()).done).toBe(true)
      const collection = reloaded.observeCollection()[Symbol.asyncIterator]()
      expect((await collection.next()).value).toMatchObject({ type: "failure" })
    }
  )

  it("retries a partially saved mixed batch, preserving commit and fragment observations after rescan", async () => {
    const backend = create()
    const watching = await initial(backend)
    storage.beforeSave = async key => {
      if (key.includes("/fragments/")) throw new Error("disk failed")
    }
    const records = [loose(1), fragment(4)]
    await expect(backend.store(tree, records)).rejects.toThrow()
    expect(await next(watching.iterator)).toMatchObject({
      type: "rescan-required",
    })
    expect((await initial(backend)).records).toEqual([loose(1)])
    await expect(backend.flush()).rejects.toBeInstanceOf(AggregateError)
    storage.beforeSave = undefined
    await backend.store(tree, records)
    await backend.flush()
    expect((await initial(backend)).records).toEqual(records)
  })

  it("rescans ambiguous fragment saves for document and collection observers", async () => {
    const backend = create()
    const watching = await initial(backend)
    const collection = backend.observeCollection()[Symbol.asyncIterator]()
    await collection.next()
    const save = storage.save.bind(storage)
    let fail = true
    vi.spyOn(storage, "save").mockImplementation(async (key, value) => {
      await save(key, value)
      if (key.includes("/fragments/") && fail) {
        fail = false
        throw new Error("ambiguous save")
      }
    })
    await expect(backend.store(tree, [fragment(4)])).rejects.toThrow()
    expect(await next(watching.iterator)).toMatchObject({
      type: "rescan-required",
    })
    expect((await collection.next()).value).toMatchObject({
      type: "rescan-required",
    })
    await backend.store(tree, [fragment(4)])
    expect((await initial(backend)).records).toEqual([fragment(4)])
    await expect(backend.flush()).rejects.toBeInstanceOf(AggregateError)
    await backend.flush()
  })

  it("reloads both kinds regardless of total history size; only single records are bounded", async () => {
    const larger = create()
    await larger.store(tree, [loose(1), fragment(4)])
    await larger.close()
    expect((await initial(create())).records).toEqual([loose(1), fragment(4)])
    const stream = create({ maxRecordBytes: recordBytes(loose(1)) })
      .open(tree)
      .events[Symbol.asyncIterator]()
    expect(await next(stream)).toMatchObject({ type: "failure" })
  })

  it.each(["commits", "fragments"])(
    "a persisted %s blob corrupted on disk is rejected by native hydration",
    async kind => {
      await create().store(tree, [loose(1), fragment(4)])
      const key = (await storage.list("subduction-v1/")).find(k =>
        k.includes(`/${kind}/`)
      )!
      const frame = JSON.parse(
        new TextDecoder().decode(await storage.load(key))
      )
      // Same size, different digest: only the blob content check can catch it.
      frame.blob =
        frame.blob.slice(0, -2) + (frame.blob.endsWith("00") ? "ff" : "00")
      await storage.save(key, new TextEncoder().encode(JSON.stringify(frame)))
      const reopened = create()
      expect((await initial(reopened)).records).toHaveLength(2)
      // The first local write hydrates native, which verifies every blob.
      await expect(reopened.store(tree, [loose(5, [4])])).rejects.toThrow()
    }
  )

  it("opens with exactly one storage read, whatever the history size", async () => {
    await create().store(tree, [loose(1), loose(4, [1]), fragment(4)])
    // Count top-level calls on a wrapper, not the DiskStore's own internals.
    const calls: string[] = []
    const counted: LocalByteStore = {
      load: key => (calls.push("load"), storage.load(key)),
      save: (key, data) => (calls.push("save"), storage.save(key, data)),
      remove: key => (calls.push("remove"), storage.remove(key)),
      list: prefix => (calls.push("list"), storage.list(prefix)),
      loadPrefix: prefix => (
        calls.push("loadPrefix"),
        storage.loadPrefix(prefix)
      ),
    }
    const loaded = await initial(create({ storage: counted }))
    expect(loaded.records).toHaveLength(3)
    expect(calls).toEqual(["loadPrefix"])
  })

  it.each(["commits", "fragments"])(
    "a corrupt stored %s found during on-demand native hydration fails the write, never reads as absent",
    async kind => {
      await create().store(tree, [loose(1), fragment(4)])
      const reopened = create()
      // Open reads and validates storage before the corruption, so it succeeds.
      expect((await initial(reopened)).records).toHaveLength(2)
      const key = (await storage.list("subduction-v1/")).find(k =>
        k.includes(`/${kind}/`)
      )!
      const frame = JSON.parse(
        new TextDecoder().decode(await storage.load(key))
      )
      frame.signedDigest = "00".repeat(32)
      await storage.save(key, new TextEncoder().encode(JSON.stringify(frame)))
      // The first local write hydrates native, which reads both kinds.
      await expect(reopened.store(tree, [loose(5, [4])])).rejects.toThrow()
      await expect(reopened.flush()).rejects.toBeInstanceOf(AggregateError)
      // A fresh open reports the corruption as a failure, not an empty tree.
      const stream = create().open(tree).events[Symbol.asyncIterator]()
      expect(await next(stream)).toMatchObject({ type: "failure" })
    }
  )

  it("rejects wire-unencodable fragment metadata before writing", async () => {
    const backend = create()
    const boundary = Array.from({ length: 256 }, (_, i) => cid(i))
    await expect(
      backend.store(tree, [{ ...fragment(4), boundary }])
    ).rejects.toMatchObject({ code: "invalid-record" })
    expect(await storage.list("subduction-v1/")).toEqual([])
    await backend.flush()
  })

  it("rescans collection observers after deletion commits but then rejects", async () => {
    const backend = create()
    await backend.store(tree, [loose(1), fragment(4)])
    const collection = backend.observeCollection()[Symbol.asyncIterator]()
    await collection.next()
    await collection.next()
    const remove = storage.remove.bind(storage)
    let fail = true
    vi.spyOn(storage, "remove").mockImplementation(async key => {
      await remove(key)
      if (key.endsWith("/id") && fail) {
        fail = false
        throw new Error("ambiguous removal")
      }
    })
    await expect(backend.deleteLocal(tree)).rejects.toThrow()
    expect((await collection.next()).value).toMatchObject({
      type: "rescan-required",
    })
    expect((await collection.next()).done).toBe(true)
    await backend.deleteLocal(tree)
    expect(await storage.list("subduction-v1/")).toEqual([])
    const fresh = backend.observeCollection()[Symbol.asyncIterator]()
    expect((await fresh.next()).value).toMatchObject({
      type: "local-load-complete",
    })
    await fresh.return!()
  })

  it.each(["delete", "close"])(
    "%s fences watches and drains a delayed fragment write",
    async operation => {
      const backend = create()
      const { iterator } = await initial(backend)
      const entered = deferred(),
        release = deferred()
      storage.beforeSave = async key => {
        if (key.includes("/fragments/")) {
          entered.resolve()
          await release.promise
        }
      }
      const writing = backend.store(tree, [fragment(4)])
      await entered.promise
      const ending =
        operation === "delete" ? backend.deleteLocal(tree) : backend.close()
      if (operation === "delete")
        expect(await next(iterator)).toMatchObject({ type: "deleted" })
      expect((await iterator.next()).done).toBe(true)
      let finished = false
      void ending.then(() => {
        finished = true
      })
      await Promise.resolve()
      expect(finished).toBe(false)
      release.resolve()
      await writing
      await ending
      if (operation === "delete") {
        expect(await storage.list("subduction-v1/")).toEqual([])
        await backend.store(tree, [fragment(4)])
        expect((await initial(backend)).records).toEqual([fragment(4)])
      } else expect((await initial(create())).records).toEqual([fragment(4)])
    }
  )
})
