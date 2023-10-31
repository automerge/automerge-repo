import { NodeFSStorageAdapter } from "@automerge/automerge-repo-storage-nodefs"
import * as A from "@automerge/automerge/next"
import assert from "assert"
import fs from "fs"
import os from "os"
import path from "path"
import { describe, it } from "vitest"
import { generateAutomergeUrl, parseAutomergeUrl } from "../src/AutomergeUrl.js"
import { StorageSubsystem } from "../src/storage/StorageSubsystem.js"
import { DummyStorageAdapter } from "./helpers/DummyStorageAdapter.js"
import { cbor } from "../src/index.js"
import { pause } from "../src/helpers/pause.js"

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "automerge-repo-tests"))

describe("StorageSubsystem", () => {
  const adaptersToTest = {
    dummyStorageAdapter: new DummyStorageAdapter(),
    nodeFSStorageAdapter: new NodeFSStorageAdapter(tempDir),
  }

  Object.entries(adaptersToTest).forEach(([adapterName, adapter]) => {
    describe(adapterName, () => {
      describe("Automerge document storage", () => {
        it("stores and retrieves an Automerge document", async () => {
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

      it("correctly stores incremental changes following a load", async () => {
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
        })

        it("removes an Automerge document", async () => {
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

          // remove it
          await storage.removeDoc(key)

          // reload it from storage
          const reloadedDoc2 = await storage.loadDoc(key)

          // check that it's undefined
          assert.equal(reloadedDoc2, undefined)
        })
      })

      describe("Arbitrary key/value storage", () => {
        it("stores and retrieves a blob", async () => {
          const storage = new StorageSubsystem(adapter)

          const value = cbor.encode({ foo: "bar" })

          const namespace = "MyCoolAdapter"
          const key = "ABC123"
          await storage.save(namespace, key, value)

          const reloadedValue = await storage.load(namespace, key)
          assert.notEqual(reloadedValue, undefined)
          assert.deepEqual(cbor.decode(reloadedValue)["foo"], "bar")
        })

        it("keeps namespaces separate", async () => {
          const storage = new StorageSubsystem(adapter)

          const key = "ABC123"

          const namespace1 = "MyCoolAdapter"
          const value1 = cbor.encode({ foo: "bar" })
          await storage.save(namespace1, key, value1)

          const namespace2 = "SomeDumbAdapter"
          const value2 = cbor.encode({ baz: "pizza" })
          await storage.save(namespace2, key, value2)

          const reloadedValue1 = await storage.load(namespace1, key)
          assert.notEqual(reloadedValue1, undefined)
          assert.deepEqual(cbor.decode(reloadedValue1)["foo"], "bar")

          const reloadedValue2 = await storage.load(namespace2, key)
          assert.notEqual(reloadedValue2, undefined)
          assert.deepEqual(cbor.decode(reloadedValue2)["baz"], "pizza")
        })

        it("removes a blob", async () => {
          const storage = new StorageSubsystem(adapter)

          const value = cbor.encode({ foo: "bar" })

          const namespace = "MyCoolAdapter"
          const key = "ABC123"
          await storage.save(namespace, key, value)

          const reloadedValue = await storage.load(namespace, key)
          assert.notEqual(reloadedValue, undefined)
          assert.deepEqual(cbor.decode(reloadedValue)["foo"], "bar")

          await storage.remove(namespace, key)

          const reloadedValue2 = await storage.load(namespace, key)
          assert.equal(reloadedValue2, undefined)
        })
      })
    })
  })
})
