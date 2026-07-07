import "fake-indexeddb/auto"
import { describe } from "vitest"

import { runStorageAdapterTests } from "../../automerge-repo/src/helpers/tests/storage-adapter-tests.js"
import { IndexedDBStorageAdapter } from "../src/index.js"

describe("IndexedDBStorageAdapter", () => {
  const setup = async () => {
    // Unique database per test: fake-indexeddb state is process-global.
    const database = `test-${Math.random().toString(36).slice(2)}`
    const adapter = new IndexedDBStorageAdapter(database)
    return {
      adapter,
      teardown: async () => {
        await adapter.close?.()
        indexedDB.deleteDatabase(database)
      },
    }
  }

  runStorageAdapterTests(setup, "IndexedDBStorageAdapter")
})
