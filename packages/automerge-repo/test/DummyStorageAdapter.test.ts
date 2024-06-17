import { beforeEach, describe } from "vitest"
import { DummyStorageAdapter } from "../src/helpers/DummyStorageAdapter.js"
import { runStorageAdapterTests } from "../src/helpers/tests/storage-adapter-tests.js"

describe("DummyStorageAdapter", () => {
  const setup = async () => ({
    adapter: new DummyStorageAdapter(),
  })

  runStorageAdapterTests(setup, "DummyStorageAdapter")
})
