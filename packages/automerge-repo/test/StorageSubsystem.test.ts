import fs from "fs"
import os from "os"
import path from "path"

import assert from "assert"

import A from "@automerge/automerge"

import { DummyStorageAdapter } from "./helpers/DummyStorageAdapter.js"
import { NodeFSStorageAdapter } from "@automerge/automerge-repo-storage-nodefs"

import { DocumentId, StorageSubsystem } from "../src"
import { TestDoc } from "./types.js"

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

  it("correctly stores incremental changes following a load", async () => {
    const adapter = new DummyStorageAdapter()
    const storage = new StorageSubsystem(adapter)

    const doc = A.change(A.init<any>(), "test", d => {
      d.foo = "bar"
    })

    // save it to storage
    const key = "test-key" as DocumentId
    storage.save(key, doc)

    // create new storage subsystem to simulate a new process
    const storage2 = new StorageSubsystem(adapter)

    // reload it from storage
    const reloadedDoc = await storage2.load<TestDoc>(key)

    // make a change
    const changedDoc = A.change(reloadedDoc, "test 2", d => {
      d.foo = "baz"
    })

    // save it to storage
    storage2.save(key, changedDoc)

    // check that the storage adapter contains the correct keys
    assert(adapter.keys().some(k => k.endsWith("1")))

    // check that the last incrementalSave is not a full save
    const bin = await adapter.load((key + ".incremental.1") as DocumentId)
    assert.throws(() => A.load(bin!))
  })
})
