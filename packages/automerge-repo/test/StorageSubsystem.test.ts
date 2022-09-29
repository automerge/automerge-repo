import fs from "fs"
import os from "os"
import path from "path"

import assert from "assert"
import Automerge from "automerge"
import { MemoryStorageAdapter } from "../src/storage/interfaces/MemoryStorageAdapter"
import { NodeFSStorageAdapter } from "../src/storage/interfaces/NodeFSStorageAdapter"
import {
  StorageSubsystem,
  StorageAdapter,
} from "../src/storage/StorageSubsystem"

describe("StorageSubsystem", () => {
  it("should accept a storage adapter at construction", () => {
    const memoryStorage = new MemoryStorageAdapter()
    const storage = new StorageSubsystem(memoryStorage)
    assert(storage.storageAdapter === memoryStorage)
  })

  const canStoreAndRetrieveAutomergeDocument = async (
    adapter: StorageAdapter
  ) => {
    const storage = new StorageSubsystem(adapter)

    const doc = Automerge.change(Automerge.init<any>(), "test", (d) => {
      d.foo = "bar"
    })

    storage.saveTotal("test-key", doc)
    const result: any = await storage.load("test-key")
    return result.foo === "bar"
  }

  describe("MemoryStorageAdapter", () => {
    it("can store and retrieve an Automerge document", async () => {
      const memoryStorage = new MemoryStorageAdapter()
      assert(canStoreAndRetrieveAutomergeDocument(memoryStorage))
    })
  })

  describe("NodeFSStorageAdapter", () => {
    it("can store and retrieve an Automerge document", async () => {
      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "automerge-repo-tests")
      )
      const nodeFSStorage = new NodeFSStorageAdapter(tempDir)
      assert(canStoreAndRetrieveAutomergeDocument(nodeFSStorage))
    })
  })

  //  these tests are browser only. right.
  // describe('LocalForageStorageAdapter', () => {
  //   const localForage = new LocalForageAdapter()

  //   it('should be able to save and retrieve', async () => {
  //     localForage.save('test-key', array)
  //     const result = await localForage.load('test-key')
  //     // console.log(array, result)
  //     assert(result == array)
  //   })

  //   it('should be able to remove data', async () => {
  //     localForage.remove('test-key')
  //     const result = await localForage.load('test-key')
  //     assert(result !== null && result.length === 0)
  //   })

  //   after(() => {
  //     localForage.remove('test-key')
  //   })
  // })
})
