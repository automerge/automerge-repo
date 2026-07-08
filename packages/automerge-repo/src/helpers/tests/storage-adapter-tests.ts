import { describe, expect, beforeEach, it as _it } from "vitest"

import type { StorageAdapterInterface } from "../../storage/StorageAdapterInterface.js"

const PAYLOAD_A = () => new Uint8Array([0, 1, 127, 99, 154, 235])
const PAYLOAD_B = () => new Uint8Array([1, 76, 160, 53, 57, 10, 230])
const PAYLOAD_C = () => new Uint8Array([2, 111, 74, 131, 236, 96, 142, 193])

const LARGE_PAYLOAD = new Uint8Array(100000).map(() => Math.random() * 256)

type AdapterTestContext = {
  adapter: StorageAdapterInterface
}

/** Sort chunks by key for order-insensitive comparison. */
const byKey = <T extends { key: string[] }>(chunks: T[]): T[] =>
  [...chunks].sort((a, b) => compareKeys(a.key, b.key))

/** Segment-wise lexicographic key comparison (0 for equal keys). */
const compareKeys = (a: string[], b: string[]): number => {
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    if (a[i] < b[i]) return -1
    if (a[i] > b[i]) return 1
  }
  return a.length - b.length
}

const it = _it<AdapterTestContext>

export function runStorageAdapterTests(setup: SetupFn, title?: string): void {
  beforeEach<AdapterTestContext>(async ctx => {
    const { adapter, teardown = NO_OP } = await setup()
    ctx.adapter = adapter
    return teardown
  })

  describe(`Storage adapter acceptance tests ${
    title ? `(${title})` : ""
  }`, () => {
    describe("load", () => {
      it("should return undefined if there is no data", async ({ adapter }) => {
        const actual = await adapter.load(["AAAAA", "sync-state", "xxxxx"])
        expect(actual).toBeUndefined()
      })
    })

    describe("save and load", () => {
      it("should return data that was saved", async ({ adapter }) => {
        await adapter.save(["storage-adapter-id"], PAYLOAD_A())
        const actual = await adapter.load(["storage-adapter-id"])
        expect(actual).toStrictEqual(PAYLOAD_A())
      })

      it("should work with composite keys", async ({ adapter }) => {
        await adapter.save(["AAAAA", "sync-state", "xxxxx"], PAYLOAD_A())
        const actual = await adapter.load(["AAAAA", "sync-state", "xxxxx"])
        expect(actual).toStrictEqual(PAYLOAD_A())
      })

      it("should work with a large payload", async ({ adapter }) => {
        await adapter.save(["AAAAA", "sync-state", "xxxxx"], LARGE_PAYLOAD)
        const actual = await adapter.load(["AAAAA", "sync-state", "xxxxx"])
        expect(actual).toStrictEqual(LARGE_PAYLOAD)
      })
    })

    describe("loadRange", () => {
      it("should return an empty array if there is no data", async ({
        adapter,
      }) => {
        expect(await adapter.loadRange(["AAAAA"])).toStrictEqual([])
      })
    })

    describe("save and loadRange", () => {
      it("should return all the data that matches the key", async ({
        adapter,
      }) => {
        await adapter.save(["AAAAA", "sync-state", "xxxxx"], PAYLOAD_A())
        await adapter.save(["AAAAA", "snapshot", "yyyyy"], PAYLOAD_B())
        await adapter.save(["AAAAA", "sync-state", "zzzzz"], PAYLOAD_C())

        // The interface makes no promise about chunk ordering (consumers
        // concatenate for loadIncremental, which is order-invariant), so
        // compare as sets: some adapters return insertion order, others
        // (e.g. LMDB) return key order.
        expect(byKey(await adapter.loadRange(["AAAAA"]))).toStrictEqual(
          byKey([
            { key: ["AAAAA", "sync-state", "xxxxx"], data: PAYLOAD_A() },
            { key: ["AAAAA", "snapshot", "yyyyy"], data: PAYLOAD_B() },
            { key: ["AAAAA", "sync-state", "zzzzz"], data: PAYLOAD_C() },
          ])
        )

        expect(
          byKey(await adapter.loadRange(["AAAAA", "sync-state"]))
        ).toStrictEqual(
          byKey([
            { key: ["AAAAA", "sync-state", "xxxxx"], data: PAYLOAD_A() },
            { key: ["AAAAA", "sync-state", "zzzzz"], data: PAYLOAD_C() },
          ])
        )
      })

      it("should enumerate every chunk for the empty prefix", async ({
        adapter,
      }) => {
        // The empty prefix matches every key — consumers rely on
        // `loadRange([])` for whole-store enumeration (e.g. migrating
        // between adapters). Include a single-component key and multiple
        // distinct first components to exercise adapter sharding schemes.
        await adapter.save(["storage-adapter-id"], PAYLOAD_A())
        await adapter.save(["AAAAA", "sync-state", "xxxxx"], PAYLOAD_B())
        await adapter.save(["BBBBB", "snapshot", "yyyyy"], PAYLOAD_C())

        expect(byKey(await adapter.loadRange([]))).toStrictEqual(
          byKey([
            { key: ["storage-adapter-id"], data: PAYLOAD_A() },
            { key: ["AAAAA", "sync-state", "xxxxx"], data: PAYLOAD_B() },
            { key: ["BBBBB", "snapshot", "yyyyy"], data: PAYLOAD_C() },
          ])
        )
      })

      it("should remove every chunk for the empty prefix and stay usable", async ({
        adapter,
      }) => {
        await adapter.save(["storage-adapter-id"], PAYLOAD_A())
        await adapter.save(["AAAAA", "sync-state", "xxxxx"], PAYLOAD_B())

        await adapter.removeRange([])
        expect(await adapter.loadRange([])).toStrictEqual([])

        // The store must remain writable after whole-store removal.
        await adapter.save(["CCCCC", "snapshot", "zzzzz"], PAYLOAD_C())
        expect(
          await adapter.load(["CCCCC", "snapshot", "zzzzz"])
        ).toStrictEqual(PAYLOAD_C())
      })

      it("should only load values that match they key", async ({ adapter }) => {
        await adapter.save(["AAAAA", "sync-state", "xxxxx"], PAYLOAD_A())
        await adapter.save(["BBBBB", "sync-state", "zzzzz"], PAYLOAD_C())

        const actual = await adapter.loadRange(["AAAAA"])
        expect(actual).toStrictEqual([
          { key: ["AAAAA", "sync-state", "xxxxx"], data: PAYLOAD_A() },
        ])
      })
    })

    describe("save and remove", () => {
      it("after removing, should be empty", async ({ adapter }) => {
        await adapter.save(["AAAAA", "snapshot", "xxxxx"], PAYLOAD_A())
        await adapter.remove(["AAAAA", "snapshot", "xxxxx"])

        expect(await adapter.loadRange(["AAAAA"])).toStrictEqual([])
        expect(
          await adapter.load(["AAAAA", "snapshot", "xxxxx"])
        ).toBeUndefined()
      })
    })

    describe("save and save", () => {
      it("should overwrite data saved with the same key", async ({
        adapter,
      }) => {
        await adapter.save(["AAAAA", "sync-state", "xxxxx"], PAYLOAD_A())
        await adapter.save(["AAAAA", "sync-state", "xxxxx"], PAYLOAD_B())

        expect(await adapter.loadRange(["AAAAA", "sync-state"])).toStrictEqual([
          { key: ["AAAAA", "sync-state", "xxxxx"], data: PAYLOAD_B() },
        ])
      })
    })

    describe("removeRange", () => {
      it("should remove a range of records", async ({ adapter }) => {
        await adapter.save(["AAAAA", "sync-state", "xxxxx"], PAYLOAD_A())
        await adapter.save(["AAAAA", "snapshot", "yyyyy"], PAYLOAD_B())
        await adapter.save(["AAAAA", "sync-state", "zzzzz"], PAYLOAD_C())

        await adapter.removeRange(["AAAAA", "sync-state"])

        expect(await adapter.loadRange(["AAAAA"])).toStrictEqual([
          { key: ["AAAAA", "snapshot", "yyyyy"], data: PAYLOAD_B() },
        ])
      })

      it("should not remove records that don't match", async ({ adapter }) => {
        await adapter.save(["AAAAA", "sync-state", "xxxxx"], PAYLOAD_A())
        await adapter.save(["BBBBB", "sync-state", "zzzzz"], PAYLOAD_B())

        await adapter.removeRange(["AAAAA"])

        const actual = await adapter.loadRange(["BBBBB"])
        expect(actual).toStrictEqual([
          { key: ["BBBBB", "sync-state", "zzzzz"], data: PAYLOAD_B() },
        ])
      })
    })
  })
}

const NO_OP = () => {}

export type SetupFn = () => Promise<{
  adapter: StorageAdapterInterface
  teardown?: () => void | Promise<void>
}>
