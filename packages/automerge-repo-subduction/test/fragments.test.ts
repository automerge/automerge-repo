// Fullfat initializes the runtime used by the backend's slim imports.
import * as N from "@automerge/subduction"
import * as A from "@automerge/automerge"
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import {
  checkpointForCommit,
  commitId,
  copyRecord,
  recordKey,
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
import { nativeId, type StorageBridge } from "../src/storage.js"
import {
  applyRecords,
  extractNewRecords,
  extractRecords,
} from "@automerge/automerge-repo/sedimentree/automerge"
import { TestStore, deferred } from "./storage.js"
import { corruptFrame, signedBytes } from "./frame.js"
import { repoFragmentFixture } from "./repoFixture.js"

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

function sameHeadVariants(): [FragmentRecord, FragmentRecord] {
  // Raw Automerge changes: F, then concurrent children K and H. F, K and H
  // hashes all start with a zero byte, so each heads a fragment. Applying K
  // before H changes H's boundary, without changing H's commit hash.
  const encoded = [
    "856f4a8300779194010a0001aa0101b002000000",
    "856f4a8300001334012b01007791944ed174f20cb0268401fab1528d20835916d604b0a0fe591eb690ad2201bb0101de8a01000000",
    "856f4a8300619aad012a01007791944ed174f20cb0268401fab1528d20835916d604b0a0fe591eb690ad2201cc0101fd02000000",
  ].map(value => new Uint8Array(Buffer.from(value, "hex")))
  const head = commitId(A.decodeChange(encoded[2]).hash)
  const variant = (order: number[]) => {
    let doc = A.init()
    for (const index of order) [doc] = A.applyChanges(doc, [encoded[index]])
    return extractRecords(doc).find(
      (record): record is FragmentRecord =>
        record.kind === "fragment" && record.head === head
    )!
  }
  return [variant([0, 2, 1]), variant([0, 1, 2])]
}
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
  let storage: TestStore, signer: N.MemorySigner
  let backends: SubductionBackend[]
  let realBoundary: {
    acknowledged: SedimentreeRecord[]
    pending: SedimentreeRecord[]
    prior: A.Doc<{ count: number }>
    after: A.Doc<{ count: number }>
  }
  beforeAll(() => {
    const changes = A.getAllChanges(repoFragmentFixture())
    const boundary = changes.findIndex(blob =>
      A.decodeChange(blob).hash.startsWith("00")
    )
    if (boundary < 1 || boundary + 1 >= changes.length)
      throw new Error("Fixture needs a boundary and a later loose commit")
    const [prior] = A.applyChanges(
      A.init<{ count: number }>({ actor: "abcdef" }),
      changes.slice(0, boundary)
    )
    // Snapshot before advancing: Automerge may mutate a prior doc's fragment cache.
    const acknowledged = extractRecords(prior)
    const [after] = A.applyChanges(
      A.clone(prior),
      changes.slice(boundary, boundary + 2)
    )
    realBoundary = {
      acknowledged,
      pending: extractNewRecords(prior, after),
      prior,
      after,
    }
    if (
      realBoundary.pending.length !== 2 ||
      !realBoundary.pending.some(r => r.kind === "fragment") ||
      !realBoundary.pending.some(r => r.kind === "commit")
    )
      throw new Error("Fixture must write a fragment and its dependent commit")
  }, 30_000)
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
    storage = new TestStore()
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

  it("retains full records across native minimization, including a commit and fragment with the same head", async () => {
    const backend = create()
    const records = [loose(1), loose(4, [1]), fragment(4)]
    await backend.store(tree, records)
    const saves = vi.spyOn(storage, "saveBatch")
    await backend.store(tree, records)
    // Exact retries may touch the ID marker, but must not rewrite records.
    expect(
      saves.mock.calls.flatMap(([entries]) =>
        entries.map(([key]) => key).filter(key => !key.endsWith("/id"))
      )
    ).toEqual([])
    expect((await initial(backend)).records).toEqual(records)
    await backend.close()
    const reloaded = create()
    const loaded = await initial(reloaded)
    expect(loaded.records).toEqual(records)
    expect(loaded.event.marker.heads).toEqual([cid(4)])
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
    const signed = N.SignedFragment.tryDecode(
      signedBytes((await storage.load(key))!)
    )
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

  it.each([
    [false, false],
    [true, false],
    [false, true],
  ])(
    "retains same-head fragment variants across restart (reverse=%s, oneBatch=%s)",
    async (reverse, oneBatch) => {
      const variants = sameHeadVariants()
      expect(variants[0].boundary).not.toEqual(variants[1].boundary)
      const ordered = reverse ? variants.reverse() : variants
      const backend = create()
      if (oneBatch) await backend.store(tree, ordered)
      else {
        await backend.store(tree, [ordered[0]])
        await backend.store(tree, [ordered[1]])
      }
      await backend.close()
      const reopened = create()
      const loaded = await initial(reopened)
      expect(loaded.records).toHaveLength(2)
      expect(loaded.records).toEqual(expect.arrayContaining(ordered))
      const { engine, bridge } = reopened as unknown as {
        engine: N.Subduction
        bridge: StorageBridge
      }
      const native = nativeId(tree)
      const head = N.CommitId.fromHexString(ordered[0].head)
      try {
        const bulk = await bridge.loadAllFragments(native)
        const loadPrefix = storage.loadPrefix.bind(storage)
        vi.spyOn(storage, "loadPrefix").mockImplementation(async prefix =>
          prefix.endsWith(`${ordered[0].head}.`)
            ? (await loadPrefix(prefix)).reverse()
            : loadPrefix(prefix)
        )
        const point = await bridge.loadFragment(native, head)
        const chosen = (await engine.getFragments(native)) ?? []
        try {
          expect(bulk).toHaveLength(2)
          expect(point).not.toBeNull()
          expect(
            bulk.some(value =>
              Buffer.from(value.blob).equals(Buffer.from(point!.blob))
            )
          ).toBe(true)
          expect(chosen).toHaveLength(1)
          const winner = ordered.find(record =>
            Buffer.from(record.blob).equals(Buffer.from(point!.blob))
          )!
          const boundary = chosen[0].boundary
          expect(boundary.map(value => value.toHexString())).toEqual(
            winner.boundary
          )
          boundary.forEach(value => value.free())
        } finally {
          bulk.forEach(value => value.free())
          point?.free()
          chosen.forEach(value => value.free())
        }
      } finally {
        head.free()
        native.free()
      }
      await reopened.store(tree, ordered)
      expect((await initial(reopened)).records).toHaveLength(2)
    }
  )

  it("deletes every variant of a fragment head", async () => {
    const backend = create()
    const variants = sameHeadVariants()
    await backend.store(tree, [...variants, loose(1)])
    const { bridge } = backend as unknown as { bridge: StorageBridge }
    const native = nativeId(tree)
    const head = N.CommitId.fromHexString(variants[0].head)
    try {
      await bridge.deleteFragment(native, head)
    } finally {
      head.free()
      native.free()
    }
    expect((await initial(backend)).records).toEqual([loose(1)])
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
    "retains a distinct same-head fragment %s representation",
    async field => {
      const backend = create()
      const original = fragment(4)
      await backend.store(tree, [original])
      const conflict = { ...original }
      if (field === "blob") conflict.blob = new Uint8Array([42])
      if (field === "boundary") conflict.boundary = []
      if (field === "checkpoints") conflict.checkpoints = []
      await backend.store(tree, [conflict])
      const records = (await initial(backend)).records
      expect(records).toHaveLength(2)
      expect(records).toEqual(expect.arrayContaining([original, conflict]))
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
      await storage.save(key, corruptFrame((await storage.load(key))!, field))
      const reloaded = create()
      const stream = reloaded.open(tree).events[Symbol.asyncIterator]()
      expect(await next(stream)).toMatchObject({ type: "failure" })
      expect((await stream.next()).done).toBe(true)
      const collection = reloaded.observeCollection()[Symbol.asyncIterator]()
      expect((await collection.next()).value).toMatchObject({ type: "failure" })
    }
  )

  it("retries a failed mixed batch without exposing any of it", async () => {
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
    expect((await initial(backend)).records).toEqual([])
    // Native may save the tree marker on its own first; no record is stored.
    expect(
      (await storage.list("subduction-v1/")).filter(key => !key.endsWith("/id"))
    ).toEqual([])
    await expect(backend.flush()).rejects.toBeInstanceOf(AggregateError)
    storage.beforeSave = undefined
    await backend.store(tree, records)
    await backend.flush()
    expect((await initial(backend)).records).toEqual(records)
  })

  it.each([1, 2, 3])(
    "stores none of a batch that fails at record %s, keeping acknowledged history",
    async failurePosition => {
      const backend = create()
      const acknowledged = loose(9)
      await backend.store(tree, [acknowledged])
      await backend.close()

      const pending = [loose(1), fragment(4), fragment(5)]
      let saves = 0
      storage.beforeSave = async key => {
        if (!key.includes("/commits/") && !key.includes("/fragments/")) return
        if (++saves === failurePosition)
          throw new Error("injected save failure")
      }
      const interrupted = create()
      await expect(interrupted.store(tree, pending)).rejects.toThrow()
      expect(saves).toBe(failurePosition)
      await interrupted.close().catch(() => {})
      storage.beforeSave = undefined

      const reopened = create()
      expect((await initial(reopened)).records).toEqual([acknowledged])
      await reopened.store(tree, pending)
      const recovered = (await initial(reopened)).records
      expect(recovered).toEqual(
        expect.arrayContaining([acknowledged, ...pending])
      )
    }
  )

  it("keeps acknowledged Automerge history when a real boundary batch fails", async () => {
    const { acknowledged, pending, prior, after } = realBoundary
    const backend = create()
    await backend.store(tree, acknowledged)
    await backend.close()
    let inspected = 0
    storage.beforeSave = key => {
      if (!key.includes("/commits/") && !key.includes("/fragments/")) return
      if (++inspected === 2) throw new Error("boundary failed")
    }
    const interrupted = create()
    await expect(interrupted.store(tree, pending)).rejects.toThrow()
    expect(inspected).toBe(2)
    await interrupted.close().catch(() => {})
    storage.beforeSave = undefined

    const reopened = create()
    const stored = (await initial(reopened)).records
    expect(stored.map(recordKey).sort()).toEqual(
      acknowledged.map(recordKey).sort()
    )
    expect(applyRecords(A.init<{ count: number }>(), stored)).toEqual(prior)
    await reopened.store(tree, pending)
    await reopened.close()
    const restored = (await initial(create())).records
    const loaded = applyRecords(A.init<{ count: number }>(), restored)
    expect(loaded).toEqual(after)
    expect(A.getHeads(loaded)).toEqual(A.getHeads(after))
    expect(
      A.getAllChanges(loaded).map(blob => A.decodeChange(blob).hash)
    ).toEqual(A.getAllChanges(after).map(blob => A.decodeChange(blob).hash))
  })

  it("rescans ambiguous fragment saves for document and collection observers", async () => {
    const backend = create()
    const watching = await initial(backend)
    const collection = backend.observeCollection()[Symbol.asyncIterator]()
    await collection.next()
    let fail = true
    storage.afterSave = keys => {
      if (keys.some(key => key.includes("/fragments/")) && fail) {
        fail = false
        throw new Error("ambiguous save")
      }
    }
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

  it("stores and reloads a record larger than the former 16 MiB limit", async () => {
    const large = {
      ...loose(1),
      blob: new Uint8Array(17 * 1024 * 1024).fill(7),
    }
    const backend = create()
    await backend.store(tree, [large, fragment(4)])
    await backend.close()
    // Compare bytes directly: a failing toEqual would try to print 17 MiB.
    const [stored, other] = (await initial(create())).records
    expect(stored.kind === "commit" && stored.id).toBe(large.id)
    expect(Buffer.compare(stored.blob, large.blob)).toBe(0)
    expect(other).toEqual(fragment(4))
  })

  it.each(["commits", "fragments"])(
    "a persisted %s blob corrupted on disk is rejected by native hydration",
    async kind => {
      await create().store(tree, [loose(1), fragment(4)])
      const key = (await storage.list("subduction-v1/")).find(k =>
        k.includes(`/${kind}/`)
      )!
      // Same size, different digest: only the blob content check can catch it.
      await storage.save(key, corruptFrame((await storage.load(key))!, "blob"))
      const reopened = create()
      expect((await initial(reopened)).records).toHaveLength(2)
      // The first local write hydrates native, which verifies every blob.
      await expect(reopened.store(tree, [loose(5, [4])])).rejects.toThrow()
    }
  )

  it("opens with exactly one storage read, whatever the history size", async () => {
    await create().store(tree, [loose(1), loose(4, [1]), fragment(4)])
    // Count top-level calls on a wrapper, not the store's own internals.
    const calls: string[] = []
    const counted: LocalByteStore = {
      load: key => (calls.push("load"), storage.load(key)),
      save: (key, data) => (calls.push("save"), storage.save(key, data)),
      saveBatch: entries => (
        calls.push("saveBatch"),
        storage.saveBatch(entries)
      ),
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
      await storage.save(
        key,
        corruptFrame((await storage.load(key))!, "digest")
      )
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
