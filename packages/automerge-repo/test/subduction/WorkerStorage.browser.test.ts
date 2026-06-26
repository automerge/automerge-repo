/**
 * Verifies the off-main-thread IndexedDB storage adapter
 * ({@link IndexedDBWorkerStorageAdapter}) round-trips through its Worker, and
 * that a Repo backed by it persists + reloads correctly (so the worker adapter
 * is a real drop-in, not just a bench).
 *
 * Gated: not part of `pnpm test` (browser-only).
 */
import { beforeAll, describe, expect, test } from "vitest"

// @ts-expect-error — initSync is exported at runtime but absent from the types
import { initSync as initSubductionWasm } from "@automerge/automerge-subduction/slim"
// @ts-expect-error — wasm-base64 has no type declarations
import { wasmBase64 } from "@automerge/automerge-subduction/wasm-base64"

import { IndexedDBWorkerStorageAdapter } from "../../../automerge-repo-storage-indexeddb/dist/IndexedDBWorkerStorageAdapter.js"
import { Repo } from "@automerge/automerge-repo"

beforeAll(() => {
  initSubductionWasm({
    module: Uint8Array.from(atob(wasmBase64), c => c.charCodeAt(0)),
  })
})

const deleteDatabase = (name: string): Promise<void> =>
  new Promise(resolve => {
    const req = indexedDB.deleteDatabase(name)
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
    req.onblocked = () => resolve()
  })

describe("IndexedDBWorkerStorageAdapter", () => {
  test("round-trips save / load / saveBatch / loadRange / remove via the worker", async () => {
    const db = `wtest-${crypto.randomUUID()}`
    const a = new IndexedDBWorkerStorageAdapter(db)
    try {
      await a.save(["x", "y"], new Uint8Array([1, 2, 3]))
      expect(Array.from((await a.load(["x", "y"])) ?? [])).toEqual([1, 2, 3])

      await a.saveBatch([
        [["p", "a"], new Uint8Array([10])],
        [["p", "b"], new Uint8Array([20])],
      ])
      const range = await a.loadRange(["p"])
      expect(range.length).toBe(2)
      expect(range.map(c => c.key[1]).sort()).toEqual(["a", "b"])

      await a.remove(["x", "y"])
      expect(await a.load(["x", "y"])).toBeUndefined()
    } finally {
      a.dispose()
      await deleteDatabase(db)
    }
  }, 60_000)

  test("a Repo backed by the worker adapter persists and reloads", async () => {
    const db = `wtest-repo-${crypto.randomUUID()}`

    const storage1 = new IndexedDBWorkerStorageAdapter(db)
    const repo1 = new Repo({ storage: storage1, network: [] })
    const handle = repo1.create<{ items: Record<string, number> }>({ items: {} })
    await handle.whenReady()
    const url = handle.url
    for (let i = 0; i < 200; i++) {
      handle.change(d => {
        d.items["k" + i] = i
      })
    }
    await repo1.flush()
    await repo1.shutdown()
    storage1.dispose()

    const storage2 = new IndexedDBWorkerStorageAdapter(db)
    const repo2 = new Repo({ storage: storage2, network: [] })
    const reloaded = await repo2.find<{ items: Record<string, number> }>(url)
    await reloaded.whenReady()
    expect(Object.keys(reloaded.doc()?.items ?? {}).length).toBe(200)
    expect(reloaded.doc()?.items["k199"]).toBe(199)
    await repo2.shutdown()
    storage2.dispose()
    await deleteDatabase(db)
  }, 120_000)
})
