import fs from "fs"
import os from "os"
import path from "path"
import assert from "assert"

import Automerge from "@automerge/automerge"

import { MemoryStorageAdapter } from "automerge-repo-storage-memory"
import { NodeFSStorageAdapter } from "automerge-repo-storage-nodefs"

import { DocumentId, StorageAdapter, StorageSubsystem } from "../src"
import { TestDoc } from "./types"

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "automerge-repo-tests"))

describe("StorageSubsystem", () => {
  const canStoreAndRetrieveAutomergeDocument = async (
    adapter: StorageAdapter
  ) => {
    const storage = new StorageSubsystem(adapter)

    const doc = Automerge.change(Automerge.init<TestDoc>(), d => {
      d.foo = "bar"
    })

    const key = "test-key" as DocumentId
    storage.save(key, doc)

    const savedDoc: any = await storage.load("test-key" as DocumentId)
    return savedDoc.foo === "bar"
  }

  describe.only("MemoryStorageAdapter", () => {
    it("can store and retrieve an Automerge document", async () => {
      const memoryStorage = new MemoryStorageAdapter()
      assert(await canStoreAndRetrieveAutomergeDocument(memoryStorage))
    })
  })

  describe("NodeFSStorageAdapter", () => {
    it("can store and retrieve an Automerge document", async () => {
      const nodeFSStorage = new NodeFSStorageAdapter(tempDir)
      assert(await canStoreAndRetrieveAutomergeDocument(nodeFSStorage))
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
