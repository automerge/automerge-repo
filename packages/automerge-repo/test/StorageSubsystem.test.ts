import { NodeFSStorageAdapter } from "../../automerge-repo-storage-nodefs/src/index.js"
import { next as A } from "@automerge/automerge"
import assert from "assert"
import fs from "fs"
import os from "os"
import path from "path"
import { describe, it, expect } from "vitest"
import { generateAutomergeUrl, parseAutomergeUrl } from "../src/AutomergeUrl.js"
import { PeerId, cbor } from "../src/index.js"
import { StorageSubsystem } from "../src/storage/StorageSubsystem.js"
import { StorageId } from "../src/storage/types.js"
import { DummyStorageAdapter } from "../src/helpers/DummyStorageAdapter.js"
import * as Uuid from "uuid"
import { chunkTypeFromKey } from "../src/storage/chunkTypeFromKey.js"
import { DocumentId } from "../src/types.js"

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "automerge-repo-tests"))

describe("StorageSubsystem", () => {
  const adaptersToTest = {
    dummyStorageAdapter: new DummyStorageAdapter(),
    nodeFSStorageAdapter: new NodeFSStorageAdapter(tempDir),
  }

  for (const [adapterName, adapter] of Object.entries(adaptersToTest)) {
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
          const bobStorageId = Uuid.v4() as StorageId

          const rawSyncState = A.decodeSyncState(A.encodeSyncState(syncState))

          await storage.saveSyncState(documentId, bobStorageId, syncState)
          const loadedSyncState = await storage.loadSyncState(
            documentId,
            bobStorageId
          )
          assert.deepStrictEqual(loadedSyncState, rawSyncState)
        })

        it("delete sync state if document is deleted", async () => {
          const storage = new StorageSubsystem(adapter)

          const { documentId } = parseAutomergeUrl(generateAutomergeUrl())
          const syncState = A.initSyncState()
          const bobStorageId = Uuid.v4() as StorageId

          await storage.saveSyncState(documentId, bobStorageId, syncState)
          await storage.removeDoc(documentId)
          const loadedSyncState = await storage.loadSyncState(
            documentId,
            bobStorageId
          )
          assert.strictEqual(loadedSyncState, undefined)
        })

        it("returns a undefined if loading an existing sync state fails", async () => {
          const storage = new StorageSubsystem(adapter)

          const { documentId } = parseAutomergeUrl(generateAutomergeUrl())
          const bobStorageId = Uuid.v4() as StorageId

          const syncStateKey = [documentId, "sync-state", bobStorageId]
          // Save garbage data to simulate a corrupted sync state
          await adapter.save(syncStateKey, Buffer.from("invalid data"))

          const loadedSyncState = await storage.loadSyncState(
            documentId,
            bobStorageId
          )
          assert.strictEqual(loadedSyncState, undefined)
        })
      })

      describe("storage id", () => {
        it("generates a unique id", async () => {
          const storage = new StorageSubsystem(adapter)

          // generate unique id and return same id on subsequence calls
          const id1 = await storage.id()
          const id2 = await storage.id()

          assert.strictEqual(Uuid.validate(id1), true)
          assert.strictEqual(Uuid.validate(id2), true)
          assert.strictEqual(id1, id2)
        })
      })

      describe("loadDoc", () => {
        it("maintains correct document state when loading chunks in order", async () => {
          const storageAdapter = new DummyStorageAdapter()
          const storage = new StorageSubsystem(storageAdapter)

          // Create a document with multiple changes
          const doc = A.init<{ foo: string }>()
          const doc1 = A.change(doc, d => {
            d.foo = "first"
          })
          const doc2 = A.change(doc1, d => {
            d.foo = "second"
          })
          const doc3 = A.change(doc2, d => {
            d.foo = "third"
          })

          // Save the document with multiple changes
          const documentId = "test-doc" as DocumentId
          await storage.saveDoc(documentId, doc3)

          // Load the document
          const loadedDoc = await storage.loadDoc<{ foo: string }>(documentId)

          // Verify the document state is correct
          expect(loadedDoc?.foo).toBe("third")
        })

        it("combines chunks with snapshot first", async () => {
          const storageAdapter = new DummyStorageAdapter()
          const storage = new StorageSubsystem(storageAdapter)

          // Create a document with multiple changes
          const doc = A.init<{ foo: string }>()
          const doc1 = A.change(doc, d => {
            d.foo = "first"
          })
          const doc2 = A.change(doc1, d => {
            d.foo = Array(10000)
              .fill(0)
              .map(() =>
                String.fromCharCode(Math.floor(Math.random() * 26) + 97)
              )
              .join("")
          })

          // Save the document with multiple changes
          const documentId = "test-doc" as DocumentId
          await storage.saveDoc(documentId, doc2)

          const doc3 = A.change(doc2, d => {
            d.foo = "third"
          })
          await storage.saveDoc(documentId, doc3)

          // Load the document
          const loadedDoc = await storage.loadDoc<{ foo: string }>(documentId)

          // Verify the document state is correct
          expect(loadedDoc?.foo).toBe(doc3.foo)

          // Get the raw binary data from storage
          const binary = await storage.loadDocData(documentId)
          expect(binary).not.toBeNull()
          if (!binary) return

          // Verify the binary starts with the Automerge magic value
          expect(binary[0]).toBe(0x85)
          expect(binary[1]).toBe(0x6f)
          expect(binary[2]).toBe(0x4a)
          expect(binary[3]).toBe(0x83)

          // Verify the chunk type is CHUNK_TYPE_DOCUMENT (0x00)
          expect(binary[8]).toBe(0x00)
        })
      })
    })
  }
})
