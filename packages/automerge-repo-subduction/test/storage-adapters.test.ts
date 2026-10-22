import { runSubductionStorageAdapterTests } from "../src/helpers/tests/subduction-storage-adapter-tests.js"
import { DummySubductionStorageAdapter } from "../src/helpers/DummySubductionStorageAdapter.js"

runSubductionStorageAdapterTests(
  async () => ({ adapter: new DummySubductionStorageAdapter() }),
  "DummySubductionStorageAdapter"
)
