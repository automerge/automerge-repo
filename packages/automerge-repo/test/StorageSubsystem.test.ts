import { NodeFSStorageAdapter } from "@automerge/automerge-repo-storage-nodefs"
import * as A from "@automerge/automerge/next"
import assert from "assert"
import fs from "fs"
import os from "os"
import path from "path"
import { describe, it } from "vitest"
import { generateAutomergeUrl, parseAutomergeUrl } from "../src/AutomergeUrl.js"
import { PeerId, cbor } from "../src/index.js"
import { StorageSubsystem } from "../src/storage/StorageSubsystem.js"
import { DummyStorageAdapter } from "./helpers/DummyStorageAdapter.js"

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

        it("retrieves an Automerge document following lots of changes", async () => {
          const storage = new StorageSubsystem(adapter)

          type TestDoc = { foo: number }

          const key = parseAutomergeUrl(generateAutomergeUrl()).documentId

          let doc = A.init<TestDoc>()

          const N = 100
          for (let i = 0; i < N; i++) {
            doc = A.change(doc, "test", d => {
              d.foo = i
            })
            // save it to storage
            await storage.saveDoc(key, doc)
          }

          // reload it from storage, simulating a new process
          const storage2 = new StorageSubsystem(adapter)
          const reloadedDoc = await storage2.loadDoc<TestDoc>(key)

          // check that the doc has the right value
          assert.equal(reloadedDoc?.foo, N - 1)
        })

        it("stores incremental changes following a load", async () => {
          const storage = new StorageSubsystem(adapter)

          const doc = A.change(A.init<any>(), "test", d => {
            d.foo = "bar"
          })

          // save it to storage
          const key = parseAutomergeUrl(generateAutomergeUrl()).documentId
          storage.saveDoc(key, doc)

          // reload it from storage, simulating a new process
          const storage2 = new StorageSubsystem(adapter)
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

      describe("sync state", () => {
        it("stores and retrieve sync state", async () => {
          const storage = new StorageSubsystem(adapter)

          const { documentId } = parseAutomergeUrl(generateAutomergeUrl())
          const syncState = A.initSyncState()
          const bob = "bob" as PeerId

          const rawSyncState = A.decodeSyncState(A.encodeSyncState(syncState))

          await storage.saveSyncState(documentId, bob, syncState)
          const loadedSyncState = await storage.loadSyncState(documentId, bob)
          assert.deepStrictEqual(loadedSyncState, rawSyncState)
        })

        it("delete sync state if document is deleted", async () => {
          const storage = new StorageSubsystem(adapter)

          const { documentId } = parseAutomergeUrl(generateAutomergeUrl())
          const syncState = A.initSyncState()
          const bob = "bob" as PeerId

          await storage.saveSyncState(documentId, bob, syncState)
          await storage.removeDoc(documentId)
          const loadedSyncState = await storage.loadSyncState(documentId, bob)
          assert.strictEqual(loadedSyncState, undefined)
        })
      })
    })
  })
})
