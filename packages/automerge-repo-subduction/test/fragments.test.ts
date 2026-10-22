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
  type SubductionStorageAdapterInterface,
  type SubductionBackendOptions,
} from "../src/index.js"
import { nativeId } from "../src/storage.js"
import {
  applyRecords,
  extractRecords,
} from "@automerge/automerge-repo/sedimentree/automerge"
import { TestStore, deferred, storedRecords } from "./storage.js"
import { corruptFrame } from "./frame.js"
import type { TestSigner } from "./transport.js"
import { repoFragmentFixture } from "./repoFixture.js"

const tree = sedimentreeId("ab".repeat(16))
const cid = (n: number) => commitId(n.toString(16).padStart(2, "0").repeat(32))
/** Distinct IDs beyond cid's 0-255 range. */
const many = (count: number) =>
  Array.from({ length: count }, (_, i) =>
    commitId(`e${i.toString(16).padStart(63, "0")}`)
  )
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

function sameHeadVariants() {
  // Raw Automerge changes: F, then concurrent children K and H. F, K and H
  // hashes all start with a zero byte, so each heads a fragment. Applying K
  // before H changes H's boundary, without changing H's commit hash.
  const encoded = [
    "856f4a8300779194010a0001aa0101b002000000",
    "856f4a8300001334012b01007791944ed174f20cb0268401fab1528d20835916d604b0a0fe591eb690ad2201bb0101de8a01000000",
    "856f4a8300619aad012a01007791944ed174f20cb0268401fab1528d20835916d604b0a0fe591eb690ad2201cc0101fd02000000",
  ].map(value => new Uint8Array(Buffer.from(value, "hex")))
  const head = commitId(A.decodeChange(encoded[2]).hash)
  const docs = [
    [0, 2, 1],
    [0, 1, 2],
  ].map(order => {
    let doc = A.init()
    for (const index of order) [doc] = A.applyChanges(doc, [encoded[index]])
    return doc
  })
  const variants = docs.map(
    doc =>
      extractRecords(doc).find(
        (record): record is FragmentRecord =>
          record.kind === "fragment" && record.head === head
      )!
  )
  return { variants, docs }
}
async function next(iterator: AsyncIterator<SedimentreeEvent>) {
  const result = await iterator.next()
  if (result.done) throw new Error("Unexpected end")
  return result.value
}
let currentStorage: TestStore
async function initial(backend: SubductionBackend, inspectRecords = true) {
  const iterator = backend.open(tree).events[Symbol.asyncIterator]()
  const records: SedimentreeRecord[] = []
  const blobs: Uint8Array[] = []
  for (;;) {
    const event = await next(iterator)
    if (event.type === "failure") throw event.error
    if (event.type === "records") records.push(...event.records)
    if (event.type === "blobs") blobs.push(...event.blobs)
    if (event.type === "local-load-complete") {
      if (!inspectRecords) return { records, blobs, event, iterator }
      records.push(...(await storedRecords(currentStorage, tree)))
      expect(
        blobs.map(blob => Buffer.from(blob).toString("hex")).sort()
      ).toEqual(
        records.map(record => Buffer.from(record.blob).toString("hex")).sort()
      )
      return { records, blobs, event, iterator }
    }
  }
}

describe("local Subduction fragments", () => {
  let storage: TestStore, signer: TestSigner
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
    // The boundary's fragment plus the loose commit after it, in one batch.
    const added = new Set(
      A.getChangesSince(after, A.getHeads(prior)).map(
        blob => A.decodeChange(blob).hash
      )
    )
    realBoundary = {
      acknowledged,
      pending: extractRecords(after, meta =>
        added.has(meta.kind === "commit" ? meta.id : meta.head)
      ),
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

  it("retains full records across native minimization, including a commit and fragment with the same head", async () => {
    const backend = create()
    const records = [loose(1), loose(4, [1]), fragment(4)]
    await backend.store(tree, records)
    // An exact retry rewrites the same keys and converges.
    await backend.store(tree, records)
    expect((await initial(backend)).records).toEqual(records)
    await backend.close()
    const reloaded = create()
    const loaded = await initial(reloaded)
    expect(loaded.records).toEqual(records)
    expect(loaded.event.marker).toBeUndefined()
    // Native hydrates on demand (not at open) and reads the stored fragment.
    const engine = (reloaded as unknown as { engine: N.Subduction }).engine
    const fragments = (await engine.getFragments(nativeId(tree))) ?? []
    expect(fragments).toHaveLength(1)
    expect(fragments[0].checkpoints).toEqual(fragment(4).checkpoints)
    expect(fragments[0].sedimentreeId).toBe(tree.padEnd(64, "0"))
  })

  it("converges when one store receives both same-head fragment variants", async () => {
    const { variants, docs } = sameHeadVariants()
    expect(variants[0].boundary).not.toEqual(variants[1].boundary)
    const backend = create()
    // Each variant arrives with the full history of the doc that produced it.
    for (const doc of docs) await backend.store(tree, extractRecords(doc))
    await backend.close()
    const loaded = applyRecords(A.init(), (await initial(create())).records)
    expect(A.getHeads(loaded)).toEqual(A.getHeads(docs[0]))
    expect(A.getHeads(loaded)).toEqual(A.getHeads(docs[1]))
    expect(loaded).toEqual(docs[0])
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

  // Tree/key relocation and blob damage are not re-checked on read (see the
  // native hydration test below for blobs).
  it.each(["signed", "missing-blob"] as const)(
    "detects persisted fragment %s corruption",
    async field => {
      const backend = create()
      await backend.store(tree, [fragment(4)])
      await backend.close()
      const key = (await storage.list("subduction-v2/")).find(k =>
        k.includes("/fragments/signed/")
      )!
      if (field === "missing-blob")
        await storage.remove(key.replace("/signed/", "/blob/"))
      else
        await storage.save(
          key,
          corruptFrame((await storage.load(key))!, "signed")
        )
      const reloaded = create()
      const stream = reloaded.open(tree).events[Symbol.asyncIterator]()
      expect(await next(stream)).toMatchObject({ type: "failure" })
      expect((await stream.next()).done).toBe(true)
      expect(await storage.list("subduction-v2/ids/")).toHaveLength(1)
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
    // Native's recovery scan finds nothing to expose.
    expect(await next(watching.iterator)).toMatchObject({
      type: "history-marker",
      marker: { heads: [] },
    })
    expect((await initial(backend)).records).toEqual([])
    // Native may register the tree first; no record is stored.
    expect(
      (await storage.list("subduction-v2/")).filter(
        key => !key.startsWith("subduction-v2/ids/")
      )
    ).toEqual([])
    storage.beforeSave = undefined
    await backend.store(tree, records)
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

  it("recovers ambiguous fragment saves for document observers", async () => {
    const backend = create()
    const watching = await initial(backend)
    let fail = true
    storage.afterSave = keys => {
      if (keys.some(key => key.includes("/fragments/")) && fail) {
        fail = false
        throw new Error("ambiguous save")
      }
    }
    await expect(backend.store(tree, [fragment(4)])).rejects.toThrow()
    // The committed fragment returns through native's recovery scan.
    expect(await next(watching.iterator)).toMatchObject({
      type: "blobs",
      blobs: [fragment(4).blob],
    })
    await backend.store(tree, [fragment(4)])
    expect((await initial(backend)).records).toEqual([fragment(4)])
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
    const blobs = (await initial(create(), false)).blobs
    expect(blobs).toHaveLength(2)
    expect(blobs.some(blob => Buffer.compare(blob, large.blob) === 0)).toBe(
      true
    )
    expect(
      blobs.some(blob => Buffer.compare(blob, fragment(4).blob) === 0)
    ).toBe(true)
  })

  it.each(["commits", "fragments"])(
    "a persisted %s blob corrupted on disk is rejected by native hydration",
    async kind => {
      await create().store(tree, [loose(1), fragment(4)])
      const key = (await storage.list("subduction-v2/")).find(k =>
        k.includes(`/${kind}/blob/`)
      )!
      // Same size, different digest: only the blob content check can catch it.
      await storage.save(key, corruptFrame((await storage.load(key))!, "blob"))
      const reopened = create()
      const session = reopened.open(tree)
      const iterator = session.events[Symbol.asyncIterator]()
      expect(await next(iterator)).toMatchObject({
        type: "failure",
        error: { operation: "open" },
      })
      expect((await iterator.next()).done).toBe(true)
      // The first local write hydrates native, which verifies every blob.
      await expect(reopened.store(tree, [loose(5, [4])])).rejects.toThrow()
    }
  )

  it("opens through Subduction's two per-kind storage reads", async () => {
    await create().store(tree, [loose(1), loose(4, [1]), fragment(4)])
    // Count top-level calls on a wrapper, not the store's own internals.
    const calls: string[] = []
    const counted: SubductionStorageAdapterInterface = {
      loadMany: keys => (calls.push("loadMany"), storage.loadMany(keys)),
      saveBatch: entries => (
        calls.push("saveBatch"),
        storage.saveBatch(entries)
      ),
      removeBatch: keys => (
        calls.push("removeBatch"),
        storage.removeBatch(keys)
      ),
      removeRange: prefix => (
        calls.push("removeRange"),
        storage.removeRange(prefix)
      ),
      list: prefix => (calls.push("list"), storage.list(prefix)),
      loadPrefix: prefix => (
        calls.push("loadPrefix"),
        storage.loadPrefix(prefix)
      ),
    }
    const loaded = await initial(create({ storage: counted }))
    expect(loaded.records).toHaveLength(3)
    expect(calls).toEqual(["loadPrefix", "loadPrefix"])
  })

  it.each(["commits", "fragments"])(
    "a corrupt stored %s found during on-demand native hydration fails the write, never reads as absent",
    async kind => {
      await create().store(tree, [loose(1), fragment(4)])
      const reopened = create()
      // Open reads and validates storage before the corruption, so it succeeds.
      expect((await initial(reopened)).records).toHaveLength(2)
      const key = (await storage.list("subduction-v2/")).find(k =>
        k.includes(`/${kind}/signed/`)
      )!
      await storage.save(
        key,
        corruptFrame((await storage.load(key))!, "signed")
      )
      // The first local write hydrates native, which reads both kinds.
      await expect(reopened.store(tree, [loose(5, [4])])).rejects.toThrow()
      // A fresh open reports the corruption as a failure, not an empty tree.
      const stream = create().open(tree).events[Symbol.asyncIterator]()
      expect(await next(stream)).toMatchObject({ type: "failure" })
    }
  )

  it.each([
    ["fragment boundary", () => ({ ...fragment(4), boundary: many(256) })],
    ["commit parents", () => ({ ...loose(1), parents: many(256) })],
  ])(
    "rejects wire-unencodable %s before writing or syncing",
    async (_, record) => {
      const backend = create()
      const engine = (backend as unknown as { engine: N.Subduction }).engine
      const rounds = vi.spyOn(engine, "syncWithAllPeers")
      await expect(backend.store(tree, [record()])).rejects.toMatchObject({
        operation: "store",
        code: "invalid-record",
        retryable: false,
      })
      expect(await storage.list("subduction-v2/")).toEqual([])
      expect(rounds).not.toHaveBeenCalled()
      await backend.flush().catch(() => {})
    }
  )

  it("retries deletion after removal commits but then rejects", async () => {
    const backend = create()
    await backend.store(tree, [loose(1), fragment(4)])
    const remove = storage.removeBatch.bind(storage)
    let fail = true
    vi.spyOn(storage, "removeBatch").mockImplementation(async keys => {
      await remove(keys)
      if (keys.some(key => key.startsWith("subduction-v2/ids/")) && fail) {
        fail = false
        throw new Error("ambiguous removal")
      }
    })
    await expect(backend.deleteLocal(tree)).rejects.toThrow()
    await backend.deleteLocal(tree)
    expect(await storage.list("subduction-v2/")).toEqual([])
  })

  it("close fences watches and drains a delayed fragment write", async () => {
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
    const ending = backend.close()
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
    expect((await initial(create())).records).toEqual([fragment(4)])
  })

  it("delete drains a delayed fragment write", async () => {
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
    const ending = backend.deleteLocal(tree)
    expect(await next(iterator)).toMatchObject({ type: "deleted" })
    release.resolve()
    await writing
    await ending
    expect(await storage.list("subduction-v2/")).toEqual([])
  })
})
