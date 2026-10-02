// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest"
import {
  MemoryBackend,
  type MemoryBackendOptions,
} from "../../src/sedimentree/testing/MemoryBackend.js"
import {
  recordBytes,
  recordHead,
  type SedimentreeRecord,
} from "../../src/sedimentree/index.js"
import {
  sedimentreeId,
  type SedimentreeId,
} from "../../src/sedimentree/index.js"
import { backendContract } from "./backend.contract.js"
import {
  cid,
  commit,
  event,
  expectPending,
  fragment,
  initial,
  next,
  settled,
  treeId,
} from "./helpers.js"

backendContract("MemoryBackend", () => new MemoryBackend())

describe("MemoryBackend exact-representation / no-network model", () => {
  const backends: MemoryBackend[] = []
  function create(options?: MemoryBackendOptions) {
    const backend = new MemoryBackend(options)
    backends.push(backend)
    return backend
  }
  afterEach(async () => {
    await Promise.all(backends.splice(0).map(backend => backend.close()))
  })

  it("keeps logical 16/32-byte namespaces distinct and validates IDs at every boundary", async () => {
    const backend = create()
    const shortId = sedimentreeId("ab".repeat(16))
    const longId = sedimentreeId("ab".repeat(16) + "cd".repeat(16))
    await backend.store(shortId, [commit(1)])
    await backend.store(longId, [commit(2)])
    expect(
      (await initial(backend.open(shortId).events[Symbol.asyncIterator]()))
        .records
    ).toEqual([commit(1)])
    expect(
      (await initial(backend.open(longId).events[Symbol.asyncIterator]()))
        .records
    ).toEqual([commit(2)])
    for (const raw of ["ab".repeat(15), "ab".repeat(33)]) {
      const invalid = raw as SedimentreeId
      expect(() => backend.open(invalid)).toThrow(TypeError)
      await expect(backend.store(invalid, [])).rejects.toThrow(TypeError)
      await expect(backend.flush([invalid])).rejects.toThrow(TypeError)
      await expect(backend.deleteLocal(invalid)).rejects.toThrow(TypeError)
    }
  })

  it("a new store after deletion can reacquire the ID without an open session", async () => {
    const backend = create()
    await backend.store(treeId(), [commit(1)])
    const old = backend.open(treeId())
    await backend.deleteLocal(treeId())
    await backend.store(treeId(), [commit(2)])
    await old.close()
    expect(
      (await initial(backend.open(treeId()).events[Symbol.asyncIterator]()))
        .records
    ).toEqual([commit(2)])
  })

  it("delivers finite bounded initial batches despite live writes during enumeration", async () => {
    const backend = create({ batchRecords: 1 })
    await backend.store(treeId(), [commit(1), commit(2), commit(3)])
    const iterator = backend.open(treeId()).events[Symbol.asyncIterator]()
    const first = await event(iterator, "records")
    expect(first).toMatchObject({ phase: "initial", records: [commit(1)] })
    await backend.store(treeId(), [commit(4)])
    for (const n of [2, 3]) {
      expect(await event(iterator, "records")).toMatchObject({
        phase: "initial",
        sequence: first.sequence,
        records: [commit(n)],
      })
      await backend.store(treeId(), [commit(n + 3)])
    }
    expect(await event(iterator, "local-load-complete")).toMatchObject({
      checkpoint: { sequence: first.sequence, heads: [cid(1), cid(2), cid(3)] },
    })
    for (const n of [4, 5, 6]) {
      const live = await event(iterator, "records")
      expect(live).toMatchObject({ phase: "live", records: [commit(n)] })
      expect(live.sequence).toBeGreaterThan(first.sequence)
      expect(
        (await event(iterator, "checkpoint")).checkpoint.sequence
      ).toBeGreaterThan(live.sequence)
    }
  })

  it("deduplicates canonical records within/across batches, without extra record or collection events", async () => {
    const backend = create()
    const session = backend.open(treeId())
    const iterator = session.events[Symbol.asyncIterator]()
    const collection = backend.observeCollection()[Symbol.asyncIterator]()
    await initial(iterator)
    await next(collection)
    const input = commit(4, [cid(3), cid(2), cid(3)])
    await backend.store(treeId(), [input, commit(4, [cid(2), cid(3)])])
    expect((await event(iterator, "records")).records).toEqual([
      commit(4, [cid(2), cid(3)]),
    ])
    await event(iterator, "checkpoint")
    await next(collection)
    await backend.store(treeId(), [input])
    // A round is a deterministic sentinel: duplicates must not precede it.
    const round = await session.synchronize()
    expect((await event(iterator, "synchronized")).result).toEqual(round)
    await backend.store(treeId(2), [commit(5)])
    expect(await next(collection)).toMatchObject({
      type: "document",
      id: treeId(2),
    })
  })

  it("does not prune readiness targets using unverified fragment boundaries", async () => {
    const backend = create()
    await backend.store(treeId(), [commit(4, [cid(3)]), fragment(5)])
    const loaded = await initial(
      backend.open(treeId()).events[Symbol.asyncIterator]()
    )
    expect(loaded.complete.checkpoint.heads).toEqual([cid(4), cid(5)])
  })

  it("retains a commit and fragment with the same head as distinct records", async () => {
    const backend = create()
    await backend.store(treeId(), [
      commit(5),
      fragment(5),
      commit(5),
      fragment(5),
    ])
    expect(
      (await initial(backend.open(treeId()).events[Symbol.asyncIterator]()))
        .records
    ).toEqual([commit(5), fragment(5)])
  })

  // Exact conflict rejection is this test double's policy, not a backend-wide
  // requirement. These tests deliberately make no batch rollback assertions.
  it.each(["blob", "parents", "boundary", "checkpoints"])(
    "rejects a conflicting %s representation rather than overwriting the stored copy",
    async field => {
      const backend = create()
      const original =
        field === "blob" || field === "parents" ? commit(5) : fragment(5)
      await backend.store(treeId(), [original])
      const conflict =
        field === "blob"
          ? { ...original, blob: new Uint8Array([99]) }
          : field === "parents"
            ? { ...commit(5), parents: [cid(2)] }
            : field === "boundary"
              ? { ...fragment(5), boundary: [cid(2)] }
              : { ...fragment(5), checkpoints: [] }
      await expect(backend.store(treeId(), [conflict])).rejects.toMatchObject({
        operation: "store",
        code: "conflict",
        retryable: false,
      })
      expect(
        (await initial(backend.open(treeId()).events[Symbol.asyncIterator]()))
          .records
      ).toEqual([original])
    }
  )

  it("reports conflicts within a batch and malformed records without promising rollback", async () => {
    const backend = create()
    await expect(
      backend.store(treeId(), [commit(1), commit(1, [], new Uint8Array([99]))])
    ).rejects.toMatchObject({ code: "conflict" })
    await expect(
      backend.store(treeId(), [commit(2), { ...commit(3), parents: [cid(3)] }])
    ).rejects.toMatchObject({ operation: "store", code: "invalid-record" })
    await expect(
      backend.store(treeId(), [
        commit(2),
        {
          ...fragment(3),
          checkpoints: [cid(1)],
        } as unknown as SedimentreeRecord,
      ])
    ).rejects.toMatchObject({ code: "invalid-record" })
    // Valid records preceding an error may or may not have persisted. Retrying
    // them must be safe regardless; exact batch atomicity is not the contract.
    await backend.store(treeId(), [commit(1), commit(2)])
    const loaded = await initial(
      backend.open(treeId()).events[Symbol.asyncIterator]()
    )
    expect(loaded.records).toHaveLength(2)
    expect(loaded.records).toEqual(
      expect.arrayContaining([commit(1), commit(2)])
    )
  })

  it("empty batches neither materialize IDs nor emit events on existing trees", async () => {
    const backend = create()
    await backend.store(treeId(), [])
    const collection = backend.observeCollection()[Symbol.asyncIterator]()
    expect((await next(collection)).type).toBe("local-load-complete")
    const session = backend.open(treeId())
    const iterator = session.events[Symbol.asyncIterator]()
    expect((await initial(iterator)).complete.found).toBe(false)
    await backend.store(treeId(), [])
    await session.synchronize()
    await event(iterator, "synchronized")
    await backend.store(treeId(2), [commit(1)])
    expect(await next(collection)).toMatchObject({
      type: "document",
      id: treeId(2),
    })
    const stored = backend.open(treeId(2))
    const si = stored.events[Symbol.asyncIterator]()
    await initial(si)
    await backend.store(treeId(2), [])
    await stored.synchronize()
    await event(si, "synchronized")
  })

  it("retains out-of-order records and fragment metadata before dependencies arrive", async () => {
    const backend = create()
    const child = commit(3, [cid(2)])
    const f = fragment(4)
    await backend.store(treeId(), [child, f])
    let load = await initial(
      backend.open(treeId()).events[Symbol.asyncIterator]()
    )
    expect(load.records).toEqual([child, f])
    expect(load.complete.checkpoint.heads).toEqual([cid(3), cid(4)])
    await backend.store(treeId(), [commit(2, [cid(1)]), commit(1)])
    load = await initial(backend.open(treeId()).events[Symbol.asyncIterator]())
    expect(load.records).toEqual([child, f, commit(2, [cid(1)]), commit(1)])
    expect(load.complete.checkpoint.heads).toEqual([cid(3), cid(4)])
  })

  it("orders no-peer synchronization checkpoints after data and correlates results with stream markers", async () => {
    const backend = create()
    const session = backend.open(treeId())
    const other = backend.open(treeId())
    const iterator = session.events[Symbol.asyncIterator]()
    const oi = other.events[Symbol.asyncIterator]()
    const cut = await initial(iterator)
    await initial(oi)
    await backend.store(treeId(), [commit(2), commit(1)])
    const round = await session.synchronize() // Resolution does not consume the stream.
    expect(round).toMatchObject({
      outcome: "no-peers",
      peers: [],
      checkpoint: { heads: [cid(1), cid(2)] },
    })
    const records = await event(iterator, "records")
    const checkpoint = await event(iterator, "checkpoint")
    const sync = await event(iterator, "synchronized")
    expect(cut.complete.checkpoint.sequence).toBeLessThan(records.sequence)
    expect(records.sequence).toBeLessThan(checkpoint.checkpoint.sequence)
    expect(checkpoint.checkpoint.sequence).toBeLessThan(
      sync.result.checkpoint.sequence
    )
    expect(sync.result).toEqual(round)
    await event(oi, "records")
    expect((await event(oi, "checkpoint")).checkpoint.heads).toEqual([
      cid(1),
      cid(2),
    ])
    expect((await event(oi, "synchronized")).result).toEqual(round)
    const second = await other.synchronize()
    expect(second.roundId).not.toBe(round.roundId)
    expect(second.checkpoint.sequence).toBeGreaterThan(
      round.checkpoint.sequence
    )
  })

  it("aborting one caller does not cancel other sessions, interest, or accepted persistence", async () => {
    const backend = create()
    const a = backend.open(treeId())
    const b = backend.open(treeId())
    const ai = a.events[Symbol.asyncIterator]()
    const bi = b.events[Symbol.asyncIterator]()
    await initial(ai)
    await initial(bi)
    const controller = new AbortController()
    const reason = new Error("caller stopped waiting")
    controller.abort(reason)
    const write = backend.store(treeId(), [commit(1)])
    await expect(a.synchronize({ signal: controller.signal })).rejects.toBe(
      reason
    )
    await write
    const round = await b.synchronize()
    for (const iterator of [ai, bi]) {
      expect((await event(iterator, "records")).records).toEqual([commit(1)])
      await event(iterator, "checkpoint")
      expect((await event(iterator, "synchronized")).result).toEqual(round)
    }
    expect((await a.synchronize()).outcome).toBe("no-peers")
  })

  it("flush settles local persistence without starting a network round or waiting for consumers", async () => {
    const backend = create()
    expect(backend.persistence).toBe("memory")
    const session = backend.open(treeId())
    const iterator = session.events[Symbol.asyncIterator]()
    await initial(iterator)
    const write = backend.store(treeId(), [commit(1)])
    await settled(backend.flush([treeId()]))
    await settled(backend.flush())
    await write
    await event(iterator, "records")
    await event(iterator, "checkpoint")
    const pending = iterator.next()
    await expectPending(pending)
    const result = await session.synchronize()
    expect((await settled(pending)).value).toEqual({
      type: "synchronized",
      result,
    })
  })

  it.each([
    { replayEvents: 1, replayBytes: 10000 },
    { replayEvents: 100, replayBytes: 64 },
  ])(
    "tree replay overflow is bounded by events AND bytes: %j",
    async options => {
      const backend = create(options)
      const slow = backend.open(treeId())
      const iterator = slow.events[Symbol.asyncIterator]()
      await initial(iterator)
      await backend.store(treeId(), [commit(1)]) // Records plus checkpoint overflow either limit.
      const overflow = await event(iterator, "rescan-required")
      expect(overflow.sequence).toBeGreaterThan(0)
      expect((await settled(iterator.next())).done).toBe(true)
      await expect(slow.synchronize()).rejects.toMatchObject({
        code: "closed",
      })
      const recovered = await initial(
        backend.open(treeId()).events[Symbol.asyncIterator]()
      )
      expect(recovered.records).toEqual([commit(1)])
      expect(recovered.complete.checkpoint.sequence).toBe(overflow.sequence)
    }
  )

  it("finishes the pinned initial cut then explicitly rescans if live replay overflowed while loading", async () => {
    const backend = create({ batchRecords: 1, replayEvents: 1 })
    await backend.store(treeId(), [commit(1), commit(2)])
    const iterator = backend.open(treeId()).events[Symbol.asyncIterator]()
    expect((await event(iterator, "records")).records).toEqual([commit(1)])
    await backend.store(treeId(), [commit(3)])
    expect((await event(iterator, "records")).records).toEqual([commit(2)])
    expect(
      (await event(iterator, "local-load-complete")).checkpoint.heads
    ).toEqual([cid(1), cid(2)])
    await event(iterator, "rescan-required")
    expect((await settled(iterator.next())).done).toBe(true)
    expect(
      (
        await initial(backend.open(treeId()).events[Symbol.asyncIterator]())
      ).records.map(recordHead)
    ).toEqual([cid(1), cid(2), cid(3)])
  })

  it.each([
    { replayEvents: 1, replayBytes: 10000 },
    { replayEvents: 100, replayBytes: 64 },
  ])(
    "collection replay overflow ends with rescan and fresh enumeration recovers: %j",
    async options => {
      const backend = create(options)
      const iterator = backend.observeCollection()[Symbol.asyncIterator]()
      expect((await next(iterator)).type).toBe("local-load-complete")
      await backend.store(treeId(1), [commit(1)])
      await backend.store(treeId(2), [commit(2)])
      expect((await next(iterator)).type).toBe("rescan-required")
      expect((await settled(iterator.next())).done).toBe(true)
      const fresh = backend.observeCollection()[Symbol.asyncIterator]()
      const ids = [await next(fresh), await next(fresh)].map(value => {
        expect(value).toMatchObject({ type: "document", phase: "initial" })
        return value.type === "document" ? value.id : undefined
      })
      expect(ids.sort()).toEqual([treeId(1), treeId(2)])
      expect((await next(fresh)).type).toBe("local-load-complete")
    }
  )

  it("a live event larger than the replay byte budget wakes a pending next with rescan", async () => {
    const backend = create({ replayBytes: 32 })
    const iterator = backend.open(treeId()).events[Symbol.asyncIterator]()
    await initial(iterator)
    const pending = iterator.next()
    await expectPending(pending)
    await backend.store(treeId(), [commit(1)])
    expect((await settled(pending)).value.type).toBe("rescan-required")
    expect((await settled(iterator.next())).done).toBe(true)
    expect(
      (await initial(backend.open(treeId()).events[Symbol.asyncIterator]()))
        .records
    ).toEqual([commit(1)])
  })

  it("batchBytes bounds batches but allows one record over the target below maxRecordBytes", async () => {
    const backend = create({
      batchRecords: 10,
      batchBytes: 66,
      maxRecordBytes: 100,
    })
    const records = [
      commit(1),
      commit(2),
      commit(3, [], new Uint8Array(40)),
      commit(4),
    ]
    await backend.store(treeId(), records)
    const iterator = backend.open(treeId()).events[Symbol.asyncIterator]()
    expect((await event(iterator, "records")).records).toEqual(
      records.slice(0, 2)
    )
    expect((await event(iterator, "records")).records).toEqual([records[2]])
    expect((await event(iterator, "records")).records).toEqual([records[3]])
    await event(iterator, "local-load-complete")
  })

  it("rejects oversized metadata/payload and accepts the exact limit", async () => {
    const record = commit(3, [cid(1)], new Uint8Array(2))
    const backend = create({ maxRecordBytes: recordBytes(record) })
    const tooLarge = { ...record, blob: new Uint8Array(3) }
    await expect(backend.store(treeId(), [tooLarge])).rejects.toMatchObject({
      operation: "store",
      code: "invalid-record",
    })
    await backend.store(treeId(), [record])
    expect(
      (await initial(backend.open(treeId()).events[Symbol.asyncIterator]()))
        .records
    ).toEqual([record])
  })

  const optionNames: (keyof MemoryBackendOptions)[] = [
    "batchRecords",
    "batchBytes",
    "maxRecordBytes",
    "replayEvents",
    "replayBytes",
  ]
  for (const option of optionNames) {
    it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
      `rejects invalid ${option}: %s`,
      value => {
        expect(() => create({ [option]: value })).toThrow(RangeError)
      }
    )
  }
})
