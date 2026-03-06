import { next as A } from "@automerge/automerge"
import assert from "assert"
import { describe, it } from "vitest"
import { generateAutomergeUrl, parseAutomergeUrl } from "../src/AutomergeUrl.js"
import { DocumentQuery } from "../src/DocumentQuery.js"
import { StorageSource } from "../src/StorageSource.js"
import { StorageSubsystem } from "../src/storage/StorageSubsystem.js"
import { DummyStorageAdapter } from "../src/helpers/DummyStorageAdapter.js"
import type { TestDoc } from "./types.js"
import { createTestQuery } from "./helpers/refConstructor.js"

describe("StorageSource", () => {
  it("merges loaded data with handle data when sync wins the race", async () => {
    type T = { fromStorage?: boolean; fromSync?: boolean; shared: string }

    const adapter = new DummyStorageAdapter()
    const documentId = parseAutomergeUrl(generateAutomergeUrl()).documentId

    // Two doc forks sharing a common base — merge works without conflict.
    const base = A.from<T>({ shared: "base" })
    const storedDoc = A.change(A.clone(base), d => {
      d.fromStorage = true
    })
    const syncedDoc = A.change(A.clone(base), d => {
      d.fromSync = true
    })

    // Slow-load adapter: defer the load() resolution until we say so.
    let releaseLoad: (() => void) | null = null
    const slowAdapter = {
      ...adapter,
      loadRange: adapter.loadRange.bind(adapter),
      load: adapter.load.bind(adapter),
      save: adapter.save.bind(adapter),
      remove: adapter.remove.bind(adapter),
      removeRange: adapter.removeRange.bind(adapter),
    }
    const originalLoadRange = slowAdapter.loadRange
    slowAdapter.loadRange = async (key: any) => {
      if (key.length >= 2 && key[1] === "snapshot") {
        await new Promise<void>(resolve => {
          releaseLoad = resolve
        })
      }
      return originalLoadRange(key)
    }

    // Pre-populate storage with storedDoc.
    const writer = new StorageSubsystem(adapter)
    await writer.saveDoc(documentId, storedDoc)

    // Set up a query + StorageSource against the slow adapter.
    const query = createTestQuery<T>(documentId)
    const source = new StorageSource(new StorageSubsystem(slowAdapter), 10_000)
    source.attach(query as DocumentQuery<unknown>)

    // While storage is loading, sync delivers its fork to the handle.
    query.handle.update(() => syncedDoc as A.Doc<unknown>)

    // Now release the storage load.
    assert.ok(releaseLoad, "storage load should be in flight")
    releaseLoad!()

    // Wait a couple of microtasks for the .then to apply.
    await new Promise(r => setTimeout(r, 10))

    const merged = query.handle.doc() as T
    assert.equal(
      merged.fromStorage,
      true,
      "storage data should not be clobbered"
    )
    assert.equal(merged.fromSync, true, "sync data should be preserved")
    assert.equal(merged.shared, "base")
  })
})
