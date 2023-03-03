import fs from "fs"
import os from "os"
import path from "path"
import assert from "assert"

import A from "@automerge/automerge"

import { DummyStorageAdapter } from "./helpers/DummyStorageAdapter"
import { NodeFSStorageAdapter } from "automerge-repo-storage-nodefs"

import { DocumentId, StorageSubsystem } from "../src"
import { TestDoc } from "./types"

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "automerge-repo-tests"))

describe("StorageSubsystem", () => {
  const adaptersToTest = {
    dummyStorageAdapter: new DummyStorageAdapter(),
    nodeFSStorageAdapter: new NodeFSStorageAdapter(tempDir),
  }

  Object.entries(adaptersToTest).forEach(([adapterName, adapter]) => {
    describe(adapterName, () => {
      it("can store and retrieve an Automerge document", async () => {
        const storage = new StorageSubsystem(adapter)

        const doc = A.change(A.init<any>(), "test", d => {
          d.foo = "bar"
        })

        // save it to storage
        const key = "test-key" as DocumentId
        storage.save(key, doc)

        // reload it from storage
        const reloadedDoc = await storage.load<TestDoc>(key)

        // check that it's the same doc
        assert.deepStrictEqual(reloadedDoc, doc)
      })
    })
  })
})
