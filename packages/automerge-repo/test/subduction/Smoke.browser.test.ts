/**
 * Toolchain smoke test for the real-browser bench harness.
 *
 * Verifies that the Playwright-driven browser environment exposes real
 * IndexedDB + WebAssembly, that `IndexedDBStorageAdapter` round-trips against
 * it, and that the Automerge Wasm bundle initialises in-browser. If this
 * passes in all three engines, the storage bench can rely on the same stack.
 */
import { expect, test } from "vitest"

import { IndexedDBStorageAdapter } from "../../../automerge-repo-storage-indexeddb/dist/index.js"

test("browser exposes real indexedDB + WebAssembly", () => {
  expect(typeof indexedDB).toBe("object")
  expect(typeof WebAssembly).toBe("object")
})

test("IndexedDBStorageAdapter round-trips against real IDB", async () => {
  const adapter = new IndexedDBStorageAdapter(`smoke-${crypto.randomUUID()}`)
  await adapter.save(["smoke", "key"], new Uint8Array([1, 2, 3]))
  const got = await adapter.load(["smoke", "key"])
  expect(Array.from(got ?? [])).toEqual([1, 2, 3])

  await adapter.saveBatch([
    [["smoke", "a"], new Uint8Array([10])],
    [["smoke", "b"], new Uint8Array([20])],
  ])
  const range = await adapter.loadRange(["smoke"])
  expect(range.length).toBeGreaterThanOrEqual(3)
})

test("Automerge Wasm initialises and round-trips in-browser", async () => {
  const A = await import("@automerge/automerge")
  let doc = A.from<{ n: number }>({ n: 0 })
  doc = A.change(doc, d => {
    d.n = 42
  })
  const bytes = A.save(doc)
  expect(bytes.byteLength).toBeGreaterThan(0)
  const reloaded = A.load<{ n: number }>(bytes)
  expect(reloaded.n).toBe(42)
})
