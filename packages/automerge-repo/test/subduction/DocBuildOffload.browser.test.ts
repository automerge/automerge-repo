/**
 * Verifies `RepoConfig.subductionOffloadDocBuild`: a large doc cold-loaded with
 * the flag on is materialised in the doc-build Worker (snapshot handoff) and
 * reloads identically to the inline path.
 *
 * Gated: browser-only.
 */
import { beforeAll, describe, expect, test } from "vitest"

// @ts-expect-error — initSync is exported at runtime but absent from the types
import { initSync as initSubductionWasm } from "@automerge/automerge-subduction/slim"
// @ts-expect-error — wasm-base64 has no type declarations
import { wasmBase64 } from "@automerge/automerge-subduction/wasm-base64"

import { IndexedDBStorageAdapter } from "../../../automerge-repo-storage-indexeddb/dist/index.js"
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

type Doc = { items: Record<string, string> }

const writeBigDoc = async (db: string, n: number): Promise<string> => {
  const repo = new Repo({
    storage: new IndexedDBStorageAdapter(db),
    network: [],
  })
  const handle = repo.create<Doc>({ items: {} })
  await handle.whenReady()
  const url = handle.url
  for (let i = 0; i < n; i++) {
    handle.change(d => {
      d.items["k" + i] = "value-number-" + i
    })
  }
  await repo.flush()
  await repo.shutdown()
  return url
}

describe("subductionOffloadDocBuild", () => {
  test("offloaded cold load reloads the full doc (large enough to cross the threshold)", async () => {
    const db = `dboff-${crypto.randomUUID()}`
    const n = 3000 // ~merged well over the 32 KiB offload threshold
    const url = await writeBigDoc(db, n)

    const repo = new Repo({
      storage: new IndexedDBStorageAdapter(db),
      network: [],
      subductionOffloadDocBuild: true,
    })
    const handle = await repo.find<Doc>(url)
    await handle.whenReady()
    const items = handle.doc()?.items ?? {}
    expect(Object.keys(items).length).toBe(n)
    expect(items["k0"]).toBe("value-number-0")
    expect(items["k" + (n - 1)]).toBe("value-number-" + (n - 1))
    await repo.shutdown()
    await deleteDatabase(db)
  }, 120_000)
})
