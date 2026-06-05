import { next as A } from "@automerge/automerge"
import assert from "assert"
import { describe, it, vi } from "vitest"
import { generateAutomergeUrl, parseAutomergeUrl } from "../src/AutomergeUrl.js"
import { DocumentQuery } from "../src/DocumentQuery.js"
import { StorageSource } from "../src/StorageSource.js"
import { StorageSubsystem } from "../src/storage/StorageSubsystem.js"
import { DummyStorageAdapter } from "../src/helpers/DummyStorageAdapter.js"
import type { TestDoc } from "./types.js"
import { createTestQuery } from "./helpers/testHandle.js"

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

  it("marks the storage source unavailable when the load fails, instead of leaving the query stuck loading", async () => {
    vi.useFakeTimers()
    try {
      type T = { foo?: string }
      const documentId = parseAutomergeUrl(generateAutomergeUrl()).documentId

      // A storage adapter whose read fails (corrupt store, disk/IO error, or
      // a failed fetch in a remote-backed adapter).
      const failingAdapter = new DummyStorageAdapter()
      failingAdapter.loadRange = async () => {
        throw new Error("storage read failed")
      }

      const query = createTestQuery<T>(documentId)
      const source = new StorageSource(
        new StorageSubsystem(failingAdapter),
        10_000
      )
      source.attach(query as DocumentQuery<unknown>)

      // attach() fires loadDoc() as a fire-and-forget promise; drain its
      // (rejected) microtask chain deterministically (no real-time wait).
      await vi.runAllTimersAsync()

      // A failed storage load must settle the "storage" source as unavailable
      // so the query can resolve. With storage the only source and no handle
      // data, the query becomes "unavailable" and whenReady() rejects.
      assert.equal(
        query.peek().state,
        "unavailable",
        "failed storage load should mark the source unavailable, not hang the query"
      )
      await assert.rejects(query.whenReady(), /unavailable/)
    } finally {
      vi.useRealTimers()
    }
  })
})
