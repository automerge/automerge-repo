import { describe, expect, it } from "vitest"
import { runSubductionStorageAdapterTests } from "../src/helpers/tests/subduction-storage-adapter-tests.js"
import { DummySubductionStorageAdapter } from "../src/helpers/DummySubductionStorageAdapter.js"

runSubductionStorageAdapterTests(
  async () => ({ adapter: new DummySubductionStorageAdapter() }),
  "DummySubductionStorageAdapter"
)

describe("DummySubductionStorageAdapter", () => {
  it("stores none of a batch that fails partway", async () => {
    const store = new DummySubductionStorageAdapter()
    await store.saveBatch([["a", new Uint8Array([1])]])
    const unreadable = {
      slice() {
        throw new Error("unreadable")
      },
    } as unknown as Uint8Array
    await expect(
      store.saveBatch([
        ["a", new Uint8Array([2])],
        ["b", new Uint8Array([3])],
        ["c", unreadable],
      ])
    ).rejects.toThrow("unreadable")
    expect(await store.loadPrefix("")).toEqual([["a", new Uint8Array([1])]])
  })

  it("applies a batch before any concurrent read observes it", async () => {
    const store = new DummySubductionStorageAdapter()
    await store.saveBatch([["b/1", new Uint8Array([0])]])
    const saving = store.saveBatch([
      ["b/1", new Uint8Array([1])],
      ["b/2", new Uint8Array([2])],
    ])
    const reading = store.loadPrefix("b/")
    await saving
    expect(await reading).toEqual([
      ["b/1", new Uint8Array([1])],
      ["b/2", new Uint8Array([2])],
    ])
  })
})
