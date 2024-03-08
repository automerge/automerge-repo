import { beforeEach, describe, expect, it } from "vitest"
import { DummyStorageAdapter } from "./helpers/DummyStorageAdapter.js"
import { runStorageAdapterTests } from "../src/helpers/tests/storage-adapter-tests.js"

describe('DummyStorageAdapter', () => {
  let sut: {adapter: DummyStorageAdapter} = { adapter: new DummyStorageAdapter() }

  beforeEach(async () => {
    sut.adapter = new DummyStorageAdapter()
  })

  runStorageAdapterTests(sut);
})
