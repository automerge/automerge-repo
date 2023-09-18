import fs from "fs"
import os from "os"
import path from "path"

import assert from "assert"

import * as A from "@automerge/automerge/next"

import { DummyStorageAdapter } from "./helpers/DummyStorageAdapter.js"
import { NodeFSStorageAdapter } from "@automerge/automerge-repo-storage-nodefs"

import { StorageSubsystem } from "../src/storage/StorageSubsystem.js"
import { generateAutomergeUrl, parseAutomergeUrl } from "../src/DocUrl.js"

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
        const key = parseAutomergeUrl(generateAutomergeUrl()).documentId
        await storage.saveDoc(key, doc)

        // reload it from storage
        const reloadedDoc = await storage.loadDoc(key)

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
    const key = parseAutomergeUrl(generateAutomergeUrl()).documentId
    storage.saveDoc(key, doc)

    // create new storage subsystem to simulate a new process
    const storage2 = new StorageSubsystem(adapter)

    // reload it from storage
    const reloadedDoc = await storage2.loadDoc(key)

    assert(reloadedDoc, "doc should be loaded")

    // make a change
    const changedDoc = A.change<any>(reloadedDoc, "test 2", d => {
      d.foo = "baz"
    })

    // save it to storage
    storage2.saveDoc(key, changedDoc)

    // check that the storage adapter contains the correct keys
    assert(adapter.keys().some(k => k.startsWith(`${key}.incremental.`)))
  })
})
