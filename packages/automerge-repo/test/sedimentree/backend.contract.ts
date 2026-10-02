import { Buffer } from "node:buffer"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { SedimentreeBackend } from "../../src/sedimentree/index.js"
import { recordHead } from "../../src/sedimentree/index.js"
import {
  cid,
  commit,
  event,
  expectPending,
  initial,
  next,
  settled,
  treeId,
} from "./helpers.js"

/** Reusable lifecycle/observation contract, independent of MemoryBackend internals.
 * Fixtures use opaque payloads; format-specific backends will need valid fixtures
 * and a scheduler-aware replacement for helpers.settled. Exact conflict handling,
 * no-network outcomes and replay tuning deliberately live in memory-only tests. */
export function backendContract(
  name: string,
  create: () => SedimentreeBackend
) {
  describe(`${name}: backend observation/lifecycle contract`, () => {
    let backend: SedimentreeBackend
    beforeEach(() => {
      backend = create()
    })
    afterEach(async () => {
      await backend.close()
    })

    it("mints distinct IDs and stores initial records before returning", async () => {
      const first = await backend.create([commit(1)])
      const second = await backend.create([commit(1)])
      expect(first).toMatch(/^[0-9a-f]{64}$/)
      expect(second).toMatch(/^[0-9a-f]{64}$/)
      expect(second).not.toBe(first)
      for (const id of [first, second]) {
        const loaded = await initial(
          backend.open(id).events[Symbol.asyncIterator]()
        )
        expect(loaded.records).toEqual([commit(1)])
        expect(loaded.complete.found).toBe(true)
      }
      await expect(backend.create([])).rejects.toMatchObject({
        operation: "create",
        code: "invalid-record",
      })
    })

    it("accepts a backend-only ID and rejects concurrent creation into stored history", async () => {
      const id = treeId()
      const empty = backend.open(id)
      await empty.close()
      const first = backend.create([commit(1)], { documentId: id })
      const second = backend.create([commit(2)], { documentId: id })
      await expect(first).resolves.toBe(id)
      await expect(second).rejects.toMatchObject({
        operation: "create",
        code: "conflict",
      })
      expect(
        (await initial(backend.open(id).events[Symbol.asyncIterator]())).records
      ).toEqual([commit(1)])
      await expect(
        backend.create([commit(2)], { documentId: "invalid" as typeof id })
      ).rejects.toThrow(TypeError)
      await backend.deleteLocal(id)
      await expect(
        backend.create([commit(2)], { documentId: id })
      ).resolves.toBe(id)
    })

    it("establishes the initial cut at open, before the first pull", async () => {
      await backend.store(treeId(), [commit(1)])
      const session = backend.open(treeId())
      await backend.store(treeId(), [commit(2, [cid(1)])])
      const iterator = session.events[Symbol.asyncIterator]()
      const loaded = await initial(iterator)
      expect(loaded.records.map(recordHead)).toEqual([cid(1)])
      expect(loaded.complete).toMatchObject({
        found: true,
        checkpoint: { heads: [cid(1)] },
      })
      const live = await event(iterator, "records")
      expect(live.phase).toBe("live")
      expect(live.records.map(recordHead)).toEqual([cid(2)])
      expect(live.sequence).toBeGreaterThan(loaded.complete.checkpoint.sequence)
    })

    it("snapshots caller-owned metadata at the store call", async () => {
      const parents = [cid(2)]
      const write = backend.store(treeId(), [commit(3, parents)])
      // The backend receives a readonly view, but the caller still owns a mutable
      // alias. Reusing it after the call must not change the accepted history.
      parents.length = 0
      await write
      const loaded = await initial(
        backend.open(treeId()).events[Symbol.asyncIterator]()
      )
      expect(loaded.records[0]).toMatchObject({ parents: [cid(2)] })
    })

    it.each(["Uint8Array", "Buffer"])(
      "isolates %s input and delivered byte buffers from stored history",
      async kind => {
        const storage =
          kind === "Buffer"
            ? Buffer.from([0, 7, 8, 0])
            : new Uint8Array([0, 7, 8, 0])
        const a = backend.open(treeId())
        const b = backend.open(treeId())
        const ai = a.events[Symbol.asyncIterator]()
        const bi = b.events[Symbol.asyncIterator]()
        await initial(ai)
        await initial(bi)
        const write = backend.store(treeId(), [
          commit(3, [cid(2)], storage.subarray(1, 3)),
        ])
        // The caller may reuse its bytes immediately, without awaiting store.
        storage.fill(99)
        await write
        const av = await event(ai, "records")
        expect(av.records[0]).toMatchObject({
          blob: new Uint8Array([7, 8]),
          parents: [cid(2)],
        })
        // Byte buffers are writable and consumer-owned. Unlike readonly
        // metadata (which may be frozen/shared), they must not alias other views.
        av.records[0].blob.fill(88)
        const bv = await event(bi, "records")
        expect(bv.records[0]).toMatchObject({
          blob: new Uint8Array([7, 8]),
          parents: [cid(2)],
        })
        const reopened = await initial(
          backend.open(treeId()).events[Symbol.asyncIterator]()
        )
        expect(reopened.records[0]).toMatchObject({
          blob: new Uint8Array([7, 8]),
          parents: [cid(2)],
        })
        reopened.records[0].blob.fill(0)
        expect(
          (await initial(backend.open(treeId()).events[Symbol.asyncIterator]()))
            .records[0].blob
        ).toEqual(new Uint8Array([7, 8]))
      }
    )

    it("keeps session lifetimes independent and preserves data across close/reopen", async () => {
      const a = backend.open(treeId())
      const b = backend.open(treeId())
      const ai = a.events[Symbol.asyncIterator]()
      const bi = b.events[Symbol.asyncIterator]()
      await initial(ai)
      await initial(bi)
      const pending = ai.next()
      await expectPending(pending)
      await a.close()
      await a.close()
      expect((await settled(pending)).done).toBe(true)
      const write = backend.store(treeId(), [commit(1)])
      await b.close() // Does not cancel the already accepted store.
      await write
      expect((await settled(bi.next())).done).toBe(true)
      expect(
        (await initial(backend.open(treeId()).events[Symbol.asyncIterator]()))
          .records
      ).toEqual([commit(1)])
      await expect(a.synchronize()).rejects.toMatchObject({
        operation: "synchronize",
        code: "closed",
      })
    })

    it.each(["return", "break"])(
      "%s during initial enumeration releases and invalidates just that watch",
      async method => {
        await backend.store(treeId(), [commit(1)])
        const a = backend.open(treeId())
        const b = backend.open(treeId())
        const ai = a.events[Symbol.asyncIterator]()
        if (method === "return") await ai.return!()
        else
          for await (const value of a.events) {
            expect(value.type).toBe("records")
            break
          }
        expect((await settled(ai.next())).done).toBe(true)
        await expect(a.synchronize()).rejects.toMatchObject({ code: "closed" })
        expect(
          (await initial(b.events[Symbol.asyncIterator]())).records
        ).toEqual([commit(1)])
      }
    )

    it("return wakes an idle next immediately", async () => {
      const session = backend.open(treeId())
      const iterator = session.events[Symbol.asyncIterator]()
      await initial(iterator)
      const pending = iterator.next()
      await expectPending(pending)
      await iterator.return!()
      expect((await settled(pending)).done).toBe(true)
      await expect(session.synchronize()).rejects.toMatchObject({
        code: "closed",
      })
    })

    it("backend close is idempotent, wakes all pending watches, and rejects new work", async () => {
      const a = backend.open(treeId())
      const b = backend.open(treeId(2))
      const ai = a.events[Symbol.asyncIterator]()
      const bi = b.events[Symbol.asyncIterator]()
      const collection = backend.observeCollection()[Symbol.asyncIterator]()
      await initial(ai)
      await initial(bi)
      expect((await next(collection)).type).toBe("local-load-complete")
      const pending: Promise<IteratorResult<unknown>>[] = [
        ai.next(),
        bi.next(),
        collection.next(),
      ]
      await Promise.all(pending.map(expectPending))
      await backend.close()
      await backend.close()
      for (const result of pending)
        expect((await settled(result)).done).toBe(true)
      expect(() => backend.open(treeId())).toThrow(
        expect.objectContaining({ operation: "open", code: "closed" })
      )
      expect(() => backend.observeCollection()).toThrow(
        expect.objectContaining({ operation: "observe", code: "closed" })
      )
      await expect(backend.store(treeId(), [commit(1)])).rejects.toMatchObject({
        operation: "store",
        code: "closed",
      })
      await expect(backend.flush()).rejects.toMatchObject({
        operation: "flush",
        code: "closed",
      })
      await expect(backend.deleteLocal(treeId())).rejects.toMatchObject({
        operation: "delete",
        code: "closed",
      })
      await expect(a.synchronize()).rejects.toMatchObject({ code: "closed" })
      await a.close()
      await b.close()
    })

    it.each(["initial", "live", "pending"])(
      "deletion supersedes %s old-generation delivery and permits explicit reopen",
      async phase => {
        await backend.store(treeId(), [commit(1)])
        const a = backend.open(treeId())
        const b = backend.open(treeId())
        const ai = a.events[Symbol.asyncIterator]()
        const bi = b.events[Symbol.asyncIterator]()
        if (phase !== "initial") await initial(ai)
        if (phase === "live") await backend.store(treeId(), [commit(2)])
        const pending = phase === "pending" ? ai.next() : undefined
        if (pending) await expectPending(pending)
        await backend.deleteLocal(treeId())
        const deleted = pending
          ? (await settled(pending)).value
          : await next(ai)
        expect(deleted.type).toBe("deleted")
        expect((await next(bi)).type).toBe("deleted")
        expect((await settled(ai.next())).done).toBe(true)
        expect((await settled(bi.next())).done).toBe(true)
        await expect(a.synchronize()).rejects.toMatchObject({ code: "closed" })
        const reopened = backend.open(treeId())
        const ri = reopened.events[Symbol.asyncIterator]()
        expect((await initial(ri)).complete.found).toBe(false)
        // Old session cleanup must not release the newly opened generation.
        await a.close()
        await b.close()
        await backend.store(treeId(), [commit(3)])
        expect((await event(ri, "records")).records).toEqual([commit(3)])
        expect(
          (await initial(backend.open(treeId()).events[Symbol.asyncIterator]()))
            .records
        ).toEqual([commit(3)])
      }
    )

    it("discovers an initial collection cut, subsequent activity and deletion, but not IDs merely opened", async () => {
      await backend.store(treeId(1), [commit(1)])
      const merelyOpened = backend.open(treeId(2))
      const collection = backend.observeCollection()[Symbol.asyncIterator]()
      await backend.store(treeId(3), [commit(3)]) // Before first pull, after cut.
      const first = await next(collection)
      expect(first).toMatchObject({
        type: "document",
        phase: "initial",
        id: treeId(1),
      })
      const cut = await next(collection)
      expect(cut).toMatchObject({
        type: "local-load-complete",
        sequence: first.sequence,
      })
      const live = await next(collection)
      expect(live).toMatchObject({
        type: "document",
        phase: "live",
        id: treeId(3),
      })
      expect(live.sequence).toBeGreaterThan(cut.sequence)
      await backend.store(treeId(1), [commit(4)])
      expect(await next(collection)).toMatchObject({
        type: "document",
        phase: "live",
        id: treeId(1),
      })
      await backend.deleteLocal(treeId(1))
      expect(await next(collection)).toMatchObject({
        type: "deleted",
        id: treeId(1),
      })
      await merelyOpened.close()
      const fresh = backend.observeCollection()[Symbol.asyncIterator]()
      expect(await next(fresh)).toMatchObject({
        type: "document",
        phase: "initial",
        id: treeId(3),
      })
      expect((await next(fresh)).type).toBe("local-load-complete")
      const pending = fresh.next()
      await expectPending(pending)
      await fresh.return!()
      expect((await settled(pending)).done).toBe(true)
      await collection.return!()
    })
  })
}
