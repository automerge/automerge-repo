import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { SubductionStorageAdapterInterface } from "../../storage/SubductionStorageAdapterInterface.js"

export type SetupFn = () => Promise<{
  adapter: SubductionStorageAdapterInterface
  teardown?: () => void | Promise<void>
}>

/** Acceptance tests every `SubductionStorageAdapterInterface` must pass. */
export function runSubductionStorageAdapterTests(
  setup: SetupFn,
  title?: string
): void {
  describe(`Subduction storage adapter acceptance tests${
    title ? ` (${title})` : ""
  }`, () => {
    let store: SubductionStorageAdapterInterface
    let teardown: (() => void | Promise<void>) | undefined
    beforeEach(async () => {
      ;({ adapter: store, teardown } = await setup())
    })
    afterEach(async () => {
      await teardown?.()
    })

    it("saves, replaces, loads, and removes single values", async () => {
      expect(await store.loadMany(["missing"])).toEqual([undefined])
      await store.saveBatch([["key", new Uint8Array([1, 2])]])
      expect(await store.loadMany(["key"])).toEqual([new Uint8Array([1, 2])])
      await store.saveBatch([["key", new Uint8Array([3])]])
      expect(await store.loadMany(["key"])).toEqual([new Uint8Array([3])])
      await store.removeBatch(["key"])
      expect(await store.loadMany(["key"])).toEqual([undefined])
    })

    it("lists and loads keys by exact prefix in sorted order", async () => {
      await store.saveBatch([
        ["a/z", new Uint8Array([1])],
        ["a", new Uint8Array([2])],
        ["a0", new Uint8Array([3])],
        ["a/b", new Uint8Array([4])],
        ["b/x", new Uint8Array([5])],
      ])
      expect(await store.list("a/")).toEqual(["a/b", "a/z"])
      expect(await store.loadPrefix("a/")).toEqual([
        ["a/b", new Uint8Array([4])],
        ["a/z", new Uint8Array([1])],
      ])
      expect(await store.list("missing")).toEqual([])
      expect(await store.loadPrefix("")).toHaveLength(5)
    })

    it("loads requested keys in order from one consistent cut", async () => {
      await store.saveBatch([
        ["pair/signed", new Uint8Array([1])],
        ["pair/blob", new Uint8Array([2])],
      ])
      const reading = store.loadMany(["pair/signed", "missing", "pair/blob"])
      const replacing = store.saveBatch([
        ["pair/signed", new Uint8Array([3])],
        ["pair/blob", new Uint8Array([4])],
      ])
      const seen = await reading
      await replacing
      expect([
        [1, undefined, 2],
        [3, undefined, 4],
      ]).toContainEqual(seen.map(value => value?.[0]))
      expect(await store.loadMany([])).toEqual([])
    })

    it("saves a batch as one visible cut", async () => {
      await store.saveBatch([["b/1", new Uint8Array([0])]])
      const saving = store.saveBatch([
        ["b/1", new Uint8Array([1])],
        ["b/2", new Uint8Array([2])],
      ])
      const reading = store.loadPrefix("b/")
      const seen = await reading
      await saving
      expect([
        [["b/1", new Uint8Array([0])]],
        [
          ["b/1", new Uint8Array([1])],
          ["b/2", new Uint8Array([2])],
        ],
      ]).toContainEqual(seen)
      expect(await store.list("b/")).toEqual(["b/1", "b/2"])
    })

    it("removes a batch together", async () => {
      await store.saveBatch([
        ["r/1", new Uint8Array([1])],
        ["r/2", new Uint8Array([2])],
        ["r/3", new Uint8Array([3])],
      ])
      const removing = store.removeBatch(["r/1", "r/3"])
      const reading = store.list("r/")
      expect([["r/1", "r/2", "r/3"], ["r/2"]]).toContainEqual(await reading)
      await removing
      expect(await store.list("r/")).toEqual(["r/2"])
    })

    it("removes every key under a prefix", async () => {
      await store.saveBatch([
        ["r", new Uint8Array([1])],
        ["r/1", new Uint8Array([2])],
        ["r/nested/2", new Uint8Array([3])],
        ["r0", new Uint8Array([4])],
      ])
      await store.removeRange("r/")
      expect(await store.list("")).toEqual(["r", "r0"])
      await store.removeRange("")
      expect(await store.list("")).toEqual([])
    })

    it("owns stored bytes and returns caller-owned bytes", async () => {
      const input = new Uint8Array([1])
      const saving = store.saveBatch([["p/key", input]])
      input[0] = 2
      await saving
      const [[, loaded]] = await store.loadPrefix("p/")
      expect(loaded).toEqual(new Uint8Array([1]))
      loaded[0] = 3
      expect(await store.loadMany(["p/key"])).toEqual([new Uint8Array([1])])
    })
  })
}
