import { next as A, Heads } from "@automerge/automerge"
import { MessageChannelNetworkAdapter } from "../../automerge-repo-network-messagechannel/src/index.js"
import assert from "assert"
import * as Uuid from "uuid"
import { describe, expect, it } from "vitest"
import {
  encodeHeads,
  getHeadsFromUrl,
  isValidAutomergeUrl,
  parseAutomergeUrl,
  generateAutomergeUrl,
  stringifyAutomergeUrl,
} from "../src/AutomergeUrl.js"
import { DocMetrics, Repo, ShareConfig } from "../src/Repo.js"
import { eventPromise } from "../src/helpers/eventPromise.js"
import { pause } from "../src/helpers/pause.js"
import {
  AnyDocumentId,
  UrlHeads,
  AutomergeUrl,
  DocHandle,
  DocumentId,
  LegacyDocumentId,
  PeerId,
  SharePolicy,
} from "../src/index.js"
import { DummyNetworkAdapter } from "../src/helpers/DummyNetworkAdapter.js"
import { DummyStorageAdapter } from "../src/helpers/DummyStorageAdapter.js"
import {
  LargeObject,
  generateLargeObject,
} from "./helpers/generate-large-object.js"
import twoPeers from "./helpers/twoPeers.js"
import connectRepos from "./helpers/connectRepos.js"
import awaitState from "./helpers/awaitState.js"
import withTimeout from "./helpers/withTimeout.js"
import { getRandomItem } from "./helpers/getRandomItem.js"
import { TestDoc } from "./types.js"
import { StorageId, StorageKey } from "../src/storage/types.js"
import { DocumentProgress } from "../src/DocumentQuery.js"
import { AbortError } from "../src/helpers/abortable.js"

describe("Repo", () => {
  describe("constructor", () => {
    it("can be instantiated without any configuration", () => {
      const repo = new Repo()
      expect(repo).toBeInstanceOf(Repo)
    })
  })

  describe("local only", () => {
    const setup = ({ startReady = true } = {}) => {
      const storageAdapter = new DummyStorageAdapter()
      const networkAdapter = new DummyNetworkAdapter({ startReady })
      const saveDebounceRate = 1
      const repo = new Repo({
        storage: storageAdapter,
        network: [networkAdapter],
        saveDebounceRate,
      })
      return { repo, storageAdapter, networkAdapter, saveDebounceRate }
    }

    it("can instantiate a Repo", () => {
      const { repo } = setup()
      assert.notEqual(repo, null)
      assert(repo.networkSubsystem)
      assert(repo.storageSubsystem)
    })

    it("can create a document", () => {
      const { repo } = setup()
      const handle = repo.create()
      assert.notEqual(handle.documentId, null)
      assert.ok(handle.doc(), "handle should have a doc")
    })

    it("can create a document with an initial value", async () => {
      const { repo } = setup()
      const handle = repo.create({ foo: "bar" })
      assert.equal(handle.doc().foo, "bar")
    })

    it("can find a document by url", async () => {
      const { repo } = setup()
      const handle = repo.create<TestDoc>()
      handle.change((d: TestDoc) => {
        d.foo = "bar"
      })

      const handle2 = await repo.find(handle.url)
      assert.equal(handle, handle2)
      assert.deepEqual(handle2.doc(), { foo: "bar" })
    })

    it("can find a document by its unprefixed document ID", async () => {
      const { repo } = setup()
      const handle = repo.create<TestDoc>()
      handle.change((d: TestDoc) => {
        d.foo = "bar"
      })

      const handle2 = await repo.find(handle.documentId)
      assert.equal(handle, handle2)
      assert.deepEqual(handle2.doc(), { foo: "bar" })
    })

    it("can find a document by legacy UUID (for now)", async () => {
      disableConsoleWarn()

      const { repo } = setup()
      const handle = repo.create<TestDoc>()
      handle.change((d: TestDoc) => {
        d.foo = "bar"
      })

      const url = handle.url
      const { binaryDocumentId } = parseAutomergeUrl(url)
      const legacyDocId = Uuid.stringify(binaryDocumentId) as LegacyDocumentId

      const handle2 = await repo.find(legacyDocId)
      assert.equal(handle, handle2)
      assert.deepEqual(handle2.doc(), { foo: "bar" })

      reenableConsoleWarn()
    })

    it("can change a document", async () => {
      const { repo } = setup()
      const handle = repo.create<TestDoc>()
      handle.change(d => {
        d.foo = "bar"
      })
      const v = handle.doc()
      assert.ok(A.getHeads(handle.doc()).length > 0)
      assert.equal(v.foo, "bar")
    })

    it("can clone a document", () => {
      const { repo } = setup()
      const handle = repo.create<TestDoc>()
      handle.change(d => {
        d.foo = "bar"
      })
      const handle2 = repo.clone(handle)
      assert.ok(A.getHeads(handle2.doc()).length > 0)
      assert.notEqual(handle.documentId, handle2.documentId)
      assert.deepStrictEqual(handle.doc(), handle2.doc())
      assert.deepStrictEqual(handle2.doc(), { foo: "bar" })
    })

    it("the cloned documents are distinct", () => {
      const { repo } = setup()
      const handle = repo.create<TestDoc>()
      handle.change(d => {
        d.foo = "bar"
      })
      const handle2 = repo.clone(handle)

      handle.change(d => {
        d.bar = "bif"
      })
      handle2.change(d => {
        d.baz = "baz"
      })

      assert.notDeepStrictEqual(handle.doc(), handle2.doc())
      assert.deepStrictEqual(handle.doc(), { foo: "bar", bar: "bif" })
      assert.deepStrictEqual(handle2.doc(), { foo: "bar", baz: "baz" })
    })

    it("the cloned documents can merge", () => {
      const { repo } = setup()
      const handle = repo.create<TestDoc>()
      handle.change(d => {
        d.foo = "bar"
      })
      const handle2 = repo.clone(handle)

      handle.change(d => {
        d.bar = "bif"
      })
      handle2.change(d => {
        d.baz = "baz"
      })

      handle.merge(handle2)

      assert.deepStrictEqual(handle.doc(), {
        foo: "bar",
        bar: "bif",
        baz: "baz",
      })
      // only the one handle should be changed
      assert.deepStrictEqual(handle2.doc(), { foo: "bar", baz: "baz" })
    })

    it("throws an error if we try to find a handle with an invalid AutomergeUrl", async () => {
      const { repo } = setup()
      await expect(async () => {
        await repo.find<TestDoc>("invalid-url" as unknown as AutomergeUrl)
      }).rejects.toThrow("Invalid AutomergeUrl: 'invalid-url'")
    })

    it("doesn't find a document that doesn't exist", async () => {
      const { repo } = setup()
      await expect(async () => {
        await repo.find<TestDoc>(generateAutomergeUrl())
      }).rejects.toThrow(/Document (.*) is unavailable/)
    })

    it("immediately marks a document as unavailable even if requested multiple times", async () => {
      /**
       * This exercises an issue where the first time a document is requested
       * from some remote and the remote doesn't have the document then it
       * immediately returns an unavailable error, but if the same document is
       * requested again before the remote is restarted then it never sends
       * the unavailable message leading to timeouts on the requesting end
       */
      const alice = new Repo({
        peerId: "alice" as PeerId,
        sharePolicy: async () => false,
      })
      const bob = new Repo({ peerId: "bob" as PeerId })
      const [aliceToBob, bobToAlice] = DummyNetworkAdapter.createConnectedPair()
      alice.networkSubsystem.addNetworkAdapter(aliceToBob)
      bob.networkSubsystem.addNetworkAdapter(bobToAlice)
      aliceToBob.peerCandidate("bob" as PeerId)
      bobToAlice.peerCandidate("alice" as PeerId)
      await Promise.all([
        alice.networkSubsystem.whenReady(),
        bob.networkSubsystem.whenReady(),
      ])

      await assert.rejects(() =>
        bob.find("automerge:uKK1dJ4vE3E6r27kz5bsFaCykvM" as AutomergeUrl)
      )
      aliceToBob.emit("peer-disconnected", { peerId: "bob" as PeerId })
      bobToAlice.emit("peer-disconnected", { peerId: "alice" as PeerId })

      const charlie = new Repo({ peerId: "charlie" as PeerId })
      const [charlieToAlice, aliceToCharlie] =
        DummyNetworkAdapter.createConnectedPair()
      charlie.networkSubsystem.addNetworkAdapter(charlieToAlice)
      alice.networkSubsystem.addNetworkAdapter(aliceToCharlie)
      charlieToAlice.peerCandidate("alice" as PeerId)
      aliceToCharlie.peerCandidate("charlie" as PeerId)
      await Promise.all([
        charlie.networkSubsystem.whenReady(),
        alice.networkSubsystem.whenReady(),
      ])

      await assert.rejects(() =>
        charlie.find("automerge:uKK1dJ4vE3E6r27kz5bsFaCykvM" as AutomergeUrl)
      )
    })

    it("should not return an unavailable handle on second request", async () => {
      const alice = new Repo({
        peerId: "alice" as PeerId,
        sharePolicy: async () => true,
      })
      await assert.rejects(() =>
        alice.find("automerge:uKK1dJ4vE3E6r27kz5bsFaCykvM" as AutomergeUrl)
      )
      await assert.rejects(() =>
        alice.find("automerge:uKK1dJ4vE3E6r27kz5bsFaCykvM" as AutomergeUrl)
      )
    })

    it("doesn't mark a document as unavailable until network adapters are ready", async () => {
      const { repo, networkAdapter } = setup({ startReady: false })
      const url = generateAutomergeUrl()

      const attemptedFind = repo.find<TestDoc>(url)

      // First verify it stays pending for 50ms
      await expect(
        Promise.race([attemptedFind, pause(50)])
      ).resolves.toBeUndefined()

      // Trigger the rejection
      networkAdapter.forceReady()

      // Now verify it rejects
      await expect(attemptedFind).rejects.toThrow(
        /Document (.*) is unavailable/
      )
    })

    it("can find a created document", async () => {
      const { repo } = setup()
      const handle = repo.create<TestDoc>()
      handle.change(d => {
        d.foo = "bar"
      })
      assert.ok(A.getHeads(handle.doc()).length > 0)

      const bobHandle = await repo.find<TestDoc>(handle.url)

      assert.equal(handle, bobHandle)
      assert.ok(A.getHeads(handle.doc()).length > 0)

      const v = bobHandle.doc()
      assert.equal(v?.foo, "bar")
    })

    it("saves the document when creating it", async () => {
      const { repo, storageAdapter } = setup()
      const handle = repo.create<TestDoc>({ foo: "saved" })

      await repo.flush()

      const repo2 = new Repo({
        storage: storageAdapter,
      })

      const bobHandle = await repo2.find<TestDoc>(handle.url)
      assert.deepEqual(bobHandle.doc(), { foo: "saved" })
    })

    it("saves the document when changed and can find it again", async () => {
      const { repo, storageAdapter } = setup()
      const handle = repo.create<TestDoc>()

      handle.change(d => {
        d.foo = "bar"
      })

      assert.ok(A.getHeads(handle.doc()).length > 0)

      await repo.flush()

      const repo2 = new Repo({
        storage: storageAdapter,
      })

      const bobHandle = await repo2.find<TestDoc>(handle.url)

      const v = bobHandle.doc()
      assert.equal(v?.foo, "bar")
    })

    it("can save several documents in quick succession", async () => {
      // See https://github.com/automerge/automerge-repo/pull/471
      const { repo, storageAdapter } = setup()
      const a = repo.create<TestDoc>()
      const b = repo.create<TestDoc>()
      const c = repo.create<TestDoc>()

      a.change(doc => (doc.foo = "a"))
      b.change(doc => (doc.foo = "b"))
      c.change(doc => (doc.foo = "c"))

      await repo.flush()

      const repo2 = new Repo({
        storage: storageAdapter,
      })

      const a2 = await repo2.find<TestDoc>(a.url)
      const b2 = await repo2.find<TestDoc>(b.url)
      const c2 = await repo2.find<TestDoc>(c.url)

      assert.deepEqual(a2?.doc(), { foo: "a" })
      assert.deepEqual(b2?.doc(), { foo: "b" })
      assert.deepEqual(c2?.doc(), { foo: "c" })
    })

    it("can delete an existing document", async () => {
      const { repo } = setup()
      const handle = repo.create<TestDoc>()
      handle.change(d => {
        d.foo = "bar"
      })
      // we now have a snapshot and an incremental change in storage
      assert.ok(A.getHeads(handle.doc()).length > 0)
      const foo = handle.doc()
      assert.equal(foo?.foo, "bar")

      await pause()
      repo.delete(handle.documentId)

      assert.equal(repo.handles[handle.documentId], undefined)
      assert.equal(repo.handles[handle.documentId], undefined)
    })

    it("can delete an existing document by url", async () => {
      const { repo } = setup()
      const handle = repo.create<TestDoc>()
      handle.change(d => {
        d.foo = "bar"
      })
      assert.ok(A.getHeads(handle.doc()).length > 0)

      await pause()
      repo.delete(handle.url)

      assert.equal(repo.handles[handle.documentId], undefined)
      assert.equal(repo.handles[handle.documentId], undefined)
    })

    it("deleting a document emits an event", async () =>
      new Promise<void>(done => {
        const { repo } = setup()
        const handle = repo.create<TestDoc>()
        handle.change(d => {
          d.foo = "bar"
        })
        assert.ok(A.getHeads(handle.doc()).length > 0)

        repo.on("delete-document", ({ documentId }) => {
          assert.equal(documentId, handle.documentId)

          done()
        })

        repo.delete(handle.documentId)
      }))

    it("deleting a document removes its data from storage", async () => {
      const { repo, storageAdapter } = setup()
      const handle = repo.create<TestDoc>()
      handle.change(d => {
        d.foo = "bar"
      })
      await repo.flush()
      assert(
        storageAdapter.keys().some(k => k.includes(handle.documentId)),
        "doc should be in storage before delete"
      )

      repo.delete(handle.documentId)
      await pause(20)

      assert(
        !storageAdapter.keys().some(k => k.includes(handle.documentId)),
        "doc should be gone from storage after delete"
      )
    })

    it("shutdown() flushes pending writes before disconnecting", async () => {
      const storageAdapter = new DummyStorageAdapter()
      const networkAdapter = new DummyNetworkAdapter()
      const repo = new Repo({
        storage: storageAdapter,
        network: [networkAdapter],
        // Long debounce so saves wouldn't naturally flush within the test.
        saveDebounceRate: 10_000,
      })
      const handle = repo.create<TestDoc>()
      handle.change(d => {
        d.foo = "bar"
      })

      await repo.shutdown()

      assert(
        storageAdapter.keys().some(k => k.includes(handle.documentId)),
        "shutdown should have flushed the doc to storage"
      )
    })

    it("exports a document", async () => {
      const { repo } = setup()
      const handle = repo.create<TestDoc>()
      handle.change(d => {
        d.foo = "bar"
      })
      assert.ok(A.getHeads(handle.doc()).length > 0)

      const exported = await repo.export(handle.documentId)
      const loaded = A.load(exported)
      const doc = handle.doc()
      assert.deepEqual(doc, loaded)
    })

    it("rejects when exporting a document that does not exist", async () => {
      const { repo } = setup()
      await assert.rejects(async () => {
        await repo.export("foo" as AnyDocumentId)
      })
    })

    it("export() loads a doc from storage when not already cached", async () => {
      // First repo writes the doc to a shared storage adapter.
      const storageAdapter = new DummyStorageAdapter()
      const repo1 = new Repo({ storage: storageAdapter, saveDebounceRate: 1 })
      const handle = repo1.create<TestDoc>()
      handle.change(d => {
        d.foo = "bar"
      })
      await repo1.flush()

      // Second repo opens the same storage; export should fetch + return data
      // even though no `find()` was called first.
      const repo2 = new Repo({ storage: storageAdapter })
      const exported = await repo2.export(handle.documentId)
      assert.ok(exported)
      assert.deepEqual(A.load(exported), { foo: "bar" })
    })

    it("storage state doesn't change across reloads when the document hasn't changed", async () => {
      const storage = new DummyStorageAdapter()

      const repo = new Repo({
        storage,
      })

      const handle = repo.create<{ count: number }>()

      handle.change(d => {
        d.count = 0
      })
      handle.change(d => {
        d.count = 1
      })

      await repo.flush()

      const initialKeys = storage.keys()

      const repo2 = new Repo({
        storage,
      })
      const handle2 = await repo2.find(handle.url)
      assert.deepEqual(storage.keys(), initialKeys)
    })

    it("doesn't delete a document from storage when we refresh", async () => {
      const storage = new DummyStorageAdapter()

      const repo = new Repo({
        storage,
      })

      const handle = repo.create<{ count: number }>()

      handle.change(d => {
        d.count = 0
      })
      handle.change(d => {
        d.count = 1
      })

      await repo.flush()

      for (let i = 0; i < 3; i++) {
        const repo2 = new Repo({
          storage,
        })
        const handle2 = await repo2.find(handle.url)
        assert(storage.keys().length !== 0)
      }
    })

    it("doesn't create multiple snapshots in storage when a series of large changes are made in succession", async () => {
      const { repo, storageAdapter } = setup()
      const handle = repo.create<{ objects: LargeObject[] }>()

      for (let i = 0; i < 5; i++) {
        handle.change(d => {
          d.objects = []
          d.objects.push(generateLargeObject(100))
        })
      }

      await repo.flush()

      const storageKeyTypes = storageAdapter.keys().map(k => k.split(".")[1])
      const storedSnapshotCount = storageKeyTypes.filter(
        k => k === "snapshot"
      ).length
      assert.equal(
        storedSnapshotCount,
        1,
        `found ${storedSnapshotCount} snapshots in storage instead of 1`
      )
    })

    it("should not create duplicate queries when find() is called in quick succession", async () => {
      const { repo, storageAdapter } = setup()
      const handle = repo.create<TestDoc>()
      handle.change(d => {
        d.foo = "bar"
      })
      await repo.flush()

      // Create a new repo instance that will use the same storage
      const repo2 = new Repo({
        storage: storageAdapter,
      })

      // Call find() twice in quick succession
      const find1 = repo2.find(handle.url)
      const find2 = repo2.find(handle.url)

      // Both should resolve to the same handle
      const [handle1, handle2] = await Promise.all([find1, find2])
      assert.equal(handle1, handle2)
    })

    it("can import an existing document", async () => {
      const { repo } = setup()
      const doc = A.init<TestDoc>()
      const updatedDoc = A.change(doc, d => {
        d.foo = "bar"
      })

      const saved = A.save(updatedDoc)

      const handle = repo.import<TestDoc>(saved)
      assert.ok(A.getHeads(handle.doc()).length > 0)
      const v = handle.doc()
      assert.equal(v?.foo, "bar")

      expect(A.getHistory(v)).toEqual(A.getHistory(updatedDoc))
    })

    it("throws an error if we try to import a nonsensical byte array", async () => {
      const { repo } = setup()
      expect(() => {
        repo.import<TestDoc>(new Uint8Array([1, 2, 3]))
      }).toThrow()
    })

    // TODO: not sure if this is the desired behavior from `import`.

    it("makes an empty document if we try to import an automerge doc", async () => {
      const { repo } = setup()
      // @ts-ignore - passing something other than UInt8Array
      const handle = repo.import<TestDoc>(A.from({ foo: 123 }))
      const doc = handle.doc()
      expect(doc).toEqual({})
    })

    it("makes an empty document if we try to import a plain object", async () => {
      const { repo } = setup()
      // @ts-ignore - passing something other than UInt8Array
      const handle = repo.import<TestDoc>({ foo: 123 })
      const doc = handle.doc()
      expect(doc).toEqual({})
    })

    describe("handle cache", () => {
      it("contains doc handle", async () => {
        const { repo } = setup()
        const handle = repo.create({ foo: "bar" })
        assert(repo.handles[handle.documentId])
      })

      it("delete removes doc handle", async () => {
        const { repo } = setup()
        const handle = repo.create({ foo: "bar" })
        await repo.delete(handle.documentId)
        assert(repo.handles[handle.documentId] === undefined)
        assert(
          repo.synchronizer.docSynchronizers[handle.documentId] === undefined
        )
      })

      it("removeFromCache removes doc handle", async () => {
        const { repo } = setup()
        const handle = repo.create({ foo: "bar" })
        await repo.removeFromCache(handle.documentId)
        assert(repo.handles[handle.documentId] === undefined)
        assert(
          repo.synchronizer.docSynchronizers[handle.documentId] === undefined
        )
      })

      it("removeFromCache for documentId not found", async () => {
        const { repo } = setup()
        const badDocumentId = "badbadbad" as DocumentId
        const handleCacheSize = Object.keys(repo.handles).length
        await repo.removeFromCache(badDocumentId)
        assert(Object.keys(repo.handles).length === handleCacheSize)
      })
    })

    describe("registerHandleWithSubsystems", () => {
      it("registers document with synchronizer when creating a new document", async () => {
        const { repo } = setup()
        const handle = repo.create<TestDoc>()
        assert(repo.synchronizer.docSynchronizers[handle.documentId])
      })

      it("registers save to storage when creating a new document", async () => {
        const { repo, storageAdapter } = setup()
        const handle = repo.create<TestDoc>()
        await pause(10) // wait for debounced save to complete
        assert(
          storageAdapter.keys().some(key => key.includes(handle.documentId))
        )
      })

      it("registers document with synchronizer when finding an existing document", async () => {
        const { repo, storageAdapter } = setup()
        const handle = repo.create<TestDoc>()
        await repo.flush()

        const repo2 = new Repo({ storage: storageAdapter })
        await repo2.find<TestDoc>(handle.url)
        assert(repo2.synchronizer.docSynchronizers[handle.documentId])
      })

      it("registers document with synchronizer when finding an existing document with progress", async () => {
        const { repo, storageAdapter } = setup()
        const handle = repo.create<TestDoc>()
        await pause(10) // wait for debounced save to complete

        const repo2 = new Repo({ storage: storageAdapter })
        repo2.findWithProgress<TestDoc>(handle.url)
        await pause(10)
        assert(repo2.synchronizer.docSynchronizers[handle.documentId])
      })

      it("registers document with synchronizer when there is no storage subsystem", async () => {
        const repo = new Repo()
        const handle = repo.create<TestDoc>()
        assert(repo.synchronizer.docSynchronizers[handle.documentId])
        // No storage = no save listener; 1 from DocumentQuery
        assert.equal(handle.listenerCount("heads-changed"), 1)
      })

      it("respects saveDebounceRate when saving", async () => {
        const storageAdapter = new DummyStorageAdapter()
        const networkAdapter = new DummyNetworkAdapter()
        const repo = new Repo({
          storage: storageAdapter,
          network: [networkAdapter],
          saveDebounceRate: 100,
        })
        const handle = repo.create<TestDoc>()

        for (let i = 0; i < 5; i++) {
          handle.change(d => {
            d.foo = `bar${i}`
          })
        }
        await pause(10)
        assert(storageAdapter.keys().length < 5)

        const keysBeforeDebouncedSave = storageAdapter.keys().length
        await pause(150)
        const keysAfterDebouncedSave = storageAdapter.keys().length
        assert(keysAfterDebouncedSave > keysBeforeDebouncedSave)
      })

      it("does not add duplicate heads-changed listeners", async () => {
        const { repo } = setup()
        const handle = repo.create<TestDoc>()
        const initialCount = handle.listenerCount("heads-changed")
        await pause(10) // wait for debounced save to complete
        await repo.find<TestDoc>(handle.url)
        repo.findWithProgress<TestDoc>(handle.url)
        await pause(10)
        // find/findWithProgress should not add extra listeners
        assert.equal(handle.listenerCount("heads-changed"), initialCount)
      })

      it("saveDoc never has two concurrent saves in flight for the same document (asyncThrottle serialization)", async () => {
        const storageAdapter = new DummyStorageAdapter()
        const repo = new Repo({ storage: storageAdapter, saveDebounceRate: 20 })

        let concurrent = 0
        let maxConcurrent = 0
        const originalSaveDoc = repo.storageSubsystem!.saveDoc.bind(
          repo.storageSubsystem
        )
        repo.storageSubsystem!.saveDoc = async (documentId, doc) => {
          concurrent++
          maxConcurrent = Math.max(maxConcurrent, concurrent)
          // saveDoc is deliberately slower than the debounce rate so a second
          // asyncThrottled call arrives while the first is still saving.
          await pause(80)
          try {
            return await originalSaveDoc(documentId, doc)
          } finally {
            concurrent--
          }
        }

        const handle = repo.create<TestDoc>()
        for (let i = 0; i < 10; i++) {
          handle.change(d => {
            d.foo = `v${i}`
          })
          await pause(15)
        }
        await pause(500)

        assert.equal(maxConcurrent, 1)
      })

      it("saveSyncState never has two concurrent saves in flight for the same storageId (asyncThrottle serialization)", async () => {
        const aliceStorage = new DummyStorageAdapter()
        const bobStorage = new DummyStorageAdapter()
        const alice = new Repo({
          peerId: "alice" as PeerId,
          storage: aliceStorage,
          saveDebounceRate: 20,
        })
        const bob = new Repo({
          peerId: "bob" as PeerId,
          storage: bobStorage,
          saveDebounceRate: 20,
        })

        // Count concurrent sync-state saves by intercepting the adapter's
        // save method and filtering by the sync-state key prefix. The Repo
        // wraps StorageSubsystem.saveSyncState with asyncThrottle keyed by
        // storageId, so even across many rapid events the adapter should
        // never see two sync-state saves in flight for the same storageId.
        let concurrent = 0
        let maxConcurrent = 0
        let syncStateSaveCalls = 0
        const originalBobSave = bobStorage.save.bind(bobStorage)
        bobStorage.save = async (key, binary) => {
          const isSyncState = key[1] === "sync-state"
          if (isSyncState) {
            concurrent++
            syncStateSaveCalls++
            maxConcurrent = Math.max(maxConcurrent, concurrent)
          }
          try {
            if (isSyncState) await pause(80)
            return await originalBobSave(key, binary)
          } finally {
            if (isSyncState) concurrent--
          }
        }

        await connectRepos(alice, bob)

        // DummyNetworkAdapter does not transmit the remote peer's metadata
        // (see peerCandidate in DummyNetworkAdapter); without it, Repo's
        // #saveSyncState early-returns because there is no storageId for the
        // peer. Populate it manually so the asyncThrottle path we want to
        // exercise is actually reached.
        const aliceStorageId = await aliceStorage
          .load(["storage-adapter-id"])
          .then(bytes => new TextDecoder().decode(bytes!) as StorageId)
        bob.peerMetadataByPeerId["alice" as PeerId] = {
          storageId: aliceStorageId,
          isEphemeral: false,
        }

        const aliceHandle = alice.create<TestDoc>({ foo: "init" })
        await bob.find(aliceHandle.url)
        await pause(20) // let the initial sync settle

        for (let i = 0; i < 15; i++) {
          aliceHandle.change(d => {
            d.foo = `v${i}`
          })
          await pause(15)
        }
        await pause(800)

        assert(
          syncStateSaveCalls > 0,
          `expected sync-state saves to be triggered, got ${syncStateSaveCalls}`
        )
        assert.equal(maxConcurrent, 1)
      })
    })
  })

  describe("flush behaviour", () => {
    const setup = () => {
      let blockedSaves = new Set<{ path: StorageKey; resolve: () => void }>()
      let resume = (documentIds?: DocumentId[]) => {
        const savesToUnblock = documentIds
          ? Array.from(blockedSaves).filter(({ path }) =>
              documentIds.some(documentId => path.includes(documentId))
            )
          : Array.from(blockedSaves)
        savesToUnblock.forEach(({ resolve }) => resolve())
      }
      const pausedStorage = new DummyStorageAdapter()
      {
        const originalSave = pausedStorage.save.bind(pausedStorage)
        pausedStorage.save = async (...args) => {
          await new Promise<void>(resolve => {
            const blockedSave = {
              path: args[0],
              resolve: () => {
                resolve()
                blockedSaves.delete(blockedSave)
              },
            }
            blockedSaves.add(blockedSave)
          })
          await pause(0)
          // otherwise all the save promises resolve together
          // which prevents testing flushing a single docID
          return originalSave(...args)
        }
      }

      const repo = new Repo({
        storage: pausedStorage,
      })

      // Create a pair of handles
      const handle = repo.create<{ foo: string }>({ foo: "first" })
      const handle2 = repo.create<{ foo: string }>({ foo: "second" })
      return { resume, pausedStorage, repo, handle, handle2 }
    }

    it("should not be in a new repo yet because the storage is slow", async () => {
      const { pausedStorage, repo, handle, handle2 } = setup()
      expect((await handle).doc().foo).toEqual("first")
      expect((await handle2).doc().foo).toEqual("second")

      // Reload repo
      const repo2 = new Repo({
        storage: pausedStorage,
      })

      // Could not find the document that is not yet saved because of slow storage.
      await expect(async () => {
        const reloadedHandle = await repo2.find<{ foo: string }>(handle.url)
      }).rejects.toThrow(/Document (.*) is unavailable/)
      expect(pausedStorage.keys()).to.deep.equal([])
    })

    it("should be visible to a new repo after flush()", async () => {
      const { resume, pausedStorage, repo, handle, handle2 } = setup()

      const flushPromise = repo.flush()
      resume()
      await flushPromise

      // Check that the data is now saved.
      expect(pausedStorage.keys().length).toBeGreaterThan(0)

      {
        // Reload repo
        const repo = new Repo({
          storage: pausedStorage,
        })

        expect(
          (await repo.find<{ foo: string }>(handle.documentId)).doc().foo
        ).toEqual("first")
        expect(
          (await repo.find<{ foo: string }>(handle2.documentId)).doc().foo
        ).toEqual("second")
      }
    })

    it("should only block on flushing requested documents", async () => {
      const { resume, pausedStorage, repo, handle, handle2 } = setup()

      const flushPromise = repo.flush([handle.documentId])
      resume([handle.documentId])
      await flushPromise

      // Check that the data is now saved.
      expect(pausedStorage.keys().length).toBeGreaterThan(0)

      {
        // Reload repo
        const repo = new Repo({
          storage: pausedStorage,
        })

        expect(
          (await repo.find<{ foo: string }>(handle.documentId)).doc().foo
        ).toEqual("first")
        // Really, it's okay if the second one is also flushed but I'm forcing the issue
        // in the test storage engine above to make sure the behaviour is as documented
        await expect(async () => {
          ;(await repo.find<{ foo: string }>(handle2.documentId)).doc()
        }).rejects.toThrow(/Document (.*) is unavailable/)
      }
    })

    it("flush right before change should resolve correctly", async () => {
      const repo = new Repo({
        network: [],
        storage: new DummyStorageAdapter(),
      })
      const handle = repo.create<{ field?: string }>()

      for (let i = 0; i < 10; i++) {
        const flushPromise = repo.flush([handle.documentId])
        handle.change((doc: any) => {
          doc.field += Array(1024)
            .fill(Math.random() * 10)
            .join("")
        })
        await flushPromise
      }
    })
  })

  describe("with peers (linear network)", async () => {
    it("n-peers connected in a line", async () => {
      const createNConnectedRepos = async (
        numberOfPeers: number,
        latency?: number
      ) => {
        const networkAdapters: DummyNetworkAdapter[][] = []
        const repos: Repo[] = []
        const networkReady: Promise<void>[] = []

        // Create n repos and connect them in a line.
        for (let idx = 0; idx < numberOfPeers; idx++) {
          const network = []

          const pair = DummyNetworkAdapter.createConnectedPair({ latency })
          networkAdapters.push(pair)

          if (idx > 0) {
            const a = networkAdapters[idx - 1][1]
            network.push(a)
            networkReady.push(a.whenReady())
          }

          if (idx < numberOfPeers - 1) {
            network.push(pair[0])
            networkReady.push(pair[0].whenReady())
          }

          const repo = new Repo({
            network,
            storage: new DummyStorageAdapter(),
            peerId: `peer-${idx}` as PeerId,
            sharePolicy: async () => true,
          })
          repos.push(repo)
        }

        await Promise.all(networkReady)

        const connectedPromise = Promise.all(
          repos.map(repo => repo.networkSubsystem.whenReady)
        )

        // Initialize the network.
        for (let idx = 0; idx < numberOfPeers; idx++) {
          if (idx > 0) {
            networkAdapters[idx - 1][1].peerCandidate(
              `peer-${idx - 1}` as PeerId
            )
          }
          if (idx < numberOfPeers - 1) {
            networkAdapters[idx][0].peerCandidate(`peer-${idx + 1}` as PeerId)
          }
        }

        await connectedPromise
        return { repos }
      }

      const numberOfPeers = 10
      const { repos } = await createNConnectedRepos(numberOfPeers, 10)

      const handle0 = repos[0].create()
      handle0.change((d: any) => {
        d.foo = "bar"
      })

      const handleN = await repos[numberOfPeers - 1].find<TestDoc>(handle0.url)
      assert.deepStrictEqual(handleN.doc(), { foo: "bar" })

      const handleNBack = repos[numberOfPeers - 1].create({
        foo: "reverse-trip",
      })
      const handle0Back = await repos[0].find<TestDoc>(handleNBack.url)
      assert.deepStrictEqual(handle0Back.doc(), { foo: "reverse-trip" })
    })

    it("re-announcing a peer ID resets document sync for pending finds", async () => {
      let dropAliceToBobMessages = true
      let bobToAlice!: DummyNetworkAdapter
      const deliver = (
        to: DummyNetworkAdapter,
        message: Parameters<DummyNetworkAdapter["receive"]>[0]
      ) => pause(0).then(() => to.receive(message))

      // Model a half-lost first connection. Bob's request reaches Alice, but
      // Alice's response is dropped. This leaves Alice with sync state that
      // says it already sent the document, while Bob's public find() is still
      // pending because it never received the response.
      const aliceToBob = new DummyNetworkAdapter({
        startReady: true,
        sendMessage: message => {
          if (!dropAliceToBobMessages) deliver(bobToAlice, message)
        },
      })
      bobToAlice = new DummyNetworkAdapter({
        startReady: true,
        sendMessage: message => deliver(aliceToBob, message),
      })

      const alice = new Repo({
        network: [aliceToBob],
        peerId: "alice" as PeerId,
        sharePolicy: async () => true,
      })
      const bob = new Repo({
        network: [bobToAlice],
        peerId: "bob" as PeerId,
        sharePolicy: async () => true,
      })

      await Promise.all([
        alice.networkSubsystem.whenReady(),
        bob.networkSubsystem.whenReady(),
      ])
      await pause(0)

      const aliceHandle = alice.create<TestDoc>({ foo: "bar" })
      const bobFind = bob.find<TestDoc>(aliceHandle.url)

      aliceToBob.peerCandidate(bob.peerId)
      bobToAlice.peerCandidate(alice.peerId)

      assert.equal(
        await withTimeout(bobFind, 100),
        undefined,
        "the dropped first connection should not sync the document"
      )

      // Invariant: a replacement connection with the same peer ID must be
      // treated as a fresh per-document sync session. Otherwise Alice keeps
      // the stale sync state from the dropped connection and may never resend
      // the document Bob is waiting for.
      dropAliceToBobMessages = false
      aliceToBob.peerCandidate(bob.peerId)
      bobToAlice.peerCandidate(alice.peerId)

      const bobHandle = await withTimeout(bobFind, 500)
      assert.ok(bobHandle, "Bob should sync after the same peer ID reconnects")
      assert.deepStrictEqual(bobHandle.doc(), { foo: "bar" })
    })

    it("uses the replacement adapter after the same peer ID is announced on another adapter", async () => {
      let bobToAlice1!: DummyNetworkAdapter
      let bobToAlice2!: DummyNetworkAdapter
      const deliver = (
        to: DummyNetworkAdapter,
        message: Parameters<DummyNetworkAdapter["receive"]>[0]
      ) => pause(0).then(() => to.receive(message))

      // Pair 1 is the original connection. Bob can send requests to Alice,
      // but Alice's responses are lost, so Bob's public find() cannot finish
      // over this connection.
      const aliceToBob1 = new DummyNetworkAdapter({
        startReady: true,
        sendMessage: () => {},
      })
      bobToAlice1 = new DummyNetworkAdapter({
        startReady: true,
        sendMessage: message => deliver(aliceToBob1, message),
      })

      // Pair 2 is a healthy replacement connection for the same peer IDs.
      const aliceToBob2 = new DummyNetworkAdapter({
        startReady: true,
        sendMessage: message => deliver(bobToAlice2, message),
      })
      bobToAlice2 = new DummyNetworkAdapter({
        startReady: true,
        sendMessage: message => deliver(aliceToBob2, message),
      })

      const alice = new Repo({
        network: [aliceToBob1, aliceToBob2],
        peerId: "alice" as PeerId,
        sharePolicy: async () => true,
      })
      const bob = new Repo({
        network: [bobToAlice1, bobToAlice2],
        peerId: "bob" as PeerId,
        sharePolicy: async () => true,
      })

      await Promise.all([
        alice.networkSubsystem.whenReady(),
        bob.networkSubsystem.whenReady(),
      ])
      await pause(0)

      const aliceHandle = alice.create<TestDoc>({ foo: "bar" })
      const bobFind = bob.find<TestDoc>(aliceHandle.url)

      aliceToBob1.peerCandidate(bob.peerId)
      bobToAlice1.peerCandidate(alice.peerId)

      assert.equal(
        await withTimeout(bobFind, 100),
        undefined,
        "the broken original adapter should not sync the document"
      )

      // Invariant: if a different adapter announces the same peer ID, the
      // repo must route the replacement sync session over that adapter. It is
      // not enough to reset DocSynchronizer state while outbound messages stay
      // pinned to the broken original adapter.
      aliceToBob2.peerCandidate(bob.peerId)
      bobToAlice2.peerCandidate(alice.peerId)

      const bobHandle = await withTimeout(bobFind, 500)
      assert.ok(bobHandle, "Bob should sync over the replacement adapter")
      assert.deepStrictEqual(bobHandle.doc(), { foo: "bar" })
    })

    it("keeps syncing after a stale replaced adapter disconnects", async () => {
      let bobToAlice1!: DummyNetworkAdapter
      let bobToAlice2!: DummyNetworkAdapter
      const deliver = (
        to: DummyNetworkAdapter,
        message: Parameters<DummyNetworkAdapter["receive"]>[0]
      ) => pause(0).then(() => to.receive(message))

      const aliceToBob1 = new DummyNetworkAdapter({
        startReady: true,
        sendMessage: message => deliver(bobToAlice1, message),
      })
      bobToAlice1 = new DummyNetworkAdapter({
        startReady: true,
        sendMessage: message => deliver(aliceToBob1, message),
      })
      const aliceToBob2 = new DummyNetworkAdapter({
        startReady: true,
        sendMessage: message => deliver(bobToAlice2, message),
      })
      bobToAlice2 = new DummyNetworkAdapter({
        startReady: true,
        sendMessage: message => deliver(aliceToBob2, message),
      })

      const alice = new Repo({
        network: [aliceToBob1, aliceToBob2],
        peerId: "alice" as PeerId,
        sharePolicy: async () => true,
      })
      const bob = new Repo({
        network: [bobToAlice1, bobToAlice2],
        peerId: "bob" as PeerId,
        sharePolicy: async () => true,
      })

      await Promise.all([
        alice.networkSubsystem.whenReady(),
        bob.networkSubsystem.whenReady(),
      ])
      await pause(0)

      aliceToBob1.peerCandidate(bob.peerId)
      bobToAlice1.peerCandidate(alice.peerId)
      aliceToBob2.peerCandidate(bob.peerId)
      bobToAlice2.peerCandidate(alice.peerId)

      // Pair 1 was replaced by pair 2. A late disconnect from pair 1 must not
      // remove the active peer route or notify Repo that the peer is gone.
      aliceToBob1.emit("peer-disconnected", { peerId: bob.peerId })
      bobToAlice1.emit("peer-disconnected", { peerId: alice.peerId })

      const aliceHandle = alice.create<TestDoc>({ foo: "bar" })
      const bobHandle = await withTimeout(
        bob.find<TestDoc>(aliceHandle.url),
        500
      )

      assert.ok(bobHandle, "Bob should still sync over the active adapter")
      assert.deepStrictEqual(bobHandle.doc(), { foo: "bar" })
    })

    const setup = async ({
      connectAlice = true,
      isCharlieEphemeral = false,
    } = {}) => {
      const charlieExcludedDocuments: DocumentId[] = []
      const bobExcludedDocuments: DocumentId[] = []

      const sharePolicy: SharePolicy = async (peerId, documentId) => {
        if (documentId === undefined) return false

        // make sure that charlie never gets excluded documents
        if (
          charlieExcludedDocuments.includes(documentId) &&
          peerId === "charlie"
        )
          return false

        // make sure that bob never gets excluded documents
        if (bobExcludedDocuments.includes(documentId) && peerId === "bob")
          return false

        return true
      }

      // Set up three repos; connect Alice to Bob, and Bob to Charlie

      const abChannel = new MessageChannel()
      const bcChannel = new MessageChannel()

      const { port1: ab, port2: ba } = abChannel
      const { port1: bc, port2: cb } = bcChannel

      const aliceNetworkAdapter = new MessageChannelNetworkAdapter(ab)

      const alice = "alice" as PeerId
      const aliceRepo = new Repo({
        network: connectAlice ? [aliceNetworkAdapter] : [],
        peerId: alice,
        sharePolicy,
      })

      const bob = "bob" as PeerId
      const bobStorage = new DummyStorageAdapter()
      const bobRepo = new Repo({
        storage: bobStorage,
        network: [
          new MessageChannelNetworkAdapter(ba),
          new MessageChannelNetworkAdapter(bc),
        ],
        peerId: bob,
        sharePolicy,
      })

      const charlie = "charlie" as PeerId
      const charlieStorage = new DummyStorageAdapter()
      const charlieRepo = new Repo({
        storage: charlieStorage,
        network: [new MessageChannelNetworkAdapter(cb)],
        peerId: charlie,
        isEphemeral: isCharlieEphemeral,
      })

      const teardown = () => {
        abChannel.port1.close()
        bcChannel.port1.close()
      }

      function connectAliceToBob() {
        aliceRepo.networkSubsystem.addNetworkAdapter(
          new MessageChannelNetworkAdapter(ab)
        )
      }

      if (connectAlice) {
        connectAliceToBob()
      }

      const aliceHandle = aliceRepo.create<TestDoc>()
      aliceHandle.change(d => {
        d.foo = "bar"
      })

      const notForCharlieHandle = aliceRepo.create<TestDoc>()
      const notForCharlie = notForCharlieHandle.documentId
      charlieExcludedDocuments.push(notForCharlie)
      notForCharlieHandle.change(d => {
        d.foo = "baz"
      })

      const notForBobHandle = aliceRepo.create<TestDoc>()
      const notForBob = notForBobHandle.documentId
      bobExcludedDocuments.push(notForBob)
      notForBobHandle.change(d => {
        d.foo = "bap"
      })

      await Promise.all([
        ...(connectAlice
          ? [eventPromise(aliceRepo.networkSubsystem, "peer")]
          : []),
        eventPromise(bobRepo.networkSubsystem, "peer"),
        eventPromise(charlieRepo.networkSubsystem, "peer"),
      ])

      return {
        alice,
        aliceRepo,
        bob,
        bobStorage,
        bobRepo,
        charlie,
        charlieStorage,
        charlieRepo,
        aliceHandle,
        notForCharlie,
        notForBob,
        teardown,
        connectAliceToBob,
      }
    }

    it("changes are replicated from aliceRepo to bobRepo", async () => {
      const { bobRepo, aliceHandle, teardown } = await setup()

      const bobHandle = await bobRepo.find<TestDoc>(aliceHandle.url)
      const bobDoc = bobHandle.doc()
      assert.deepStrictEqual(bobDoc, { foo: "bar" })
      teardown()
    })

    it("can load a document from aliceRepo on charlieRepo", async () => {
      const { charlieRepo, aliceHandle, teardown } = await setup()

      const handle3 = await charlieRepo.find<TestDoc>(aliceHandle.url)
      const doc3 = handle3.doc()
      assert.deepStrictEqual(doc3, { foo: "bar" })
      teardown()
    })

    it("synchronizes changes from bobRepo to charlieRepo when loading from storage", async () => {
      const { bobRepo, bobStorage, teardown } = await setup()

      // We create a repo that uses bobStorage to put a document into its imaginary disk
      // without it knowing about it
      const bobRepo2 = new Repo({
        storage: bobStorage,
      })
      const inStorageHandle = bobRepo2.create<TestDoc>({
        foo: "foundOnFakeDisk",
      })
      await bobRepo2.flush()

      // Now, let's load it on the original bob repo (which shares a "disk")
      const bobFoundIt = await bobRepo.find<TestDoc>(inStorageHandle.url)

      // Before checking if it syncs, make sure we have it!
      // (This behaviour is mostly test-validation, we are already testing load/save elsewhere.)
      assert.deepStrictEqual(bobFoundIt.doc(), { foo: "foundOnFakeDisk" })

      await pause(10)

      // We should have a docSynchronizer and its peers should be alice and charlie
      assert.strictEqual(
        bobRepo.synchronizer.docSynchronizers[bobFoundIt.documentId]?.hasPeer(
          "alice" as PeerId
        ),
        true
      )
      assert.strictEqual(
        bobRepo.synchronizer.docSynchronizers[bobFoundIt.documentId]?.hasPeer(
          "charlie" as PeerId
        ),
        true
      )

      teardown()
    })

    it("does not report unavailable while a peer is still checking a higher-priority source", async () => {
      // This test checks that if we request a document from someone who has a
      // slow storage source then they wait until the storage lookup is complete
      // before reporting on the state of their document. If they run sync and storage
      // concurrently and don't wait for storage before making unavailability decisions
      // then they may report unavailable before the storage lookup is complete
      const storage = new DummyStorageAdapter()

      // Make sure there is a document in storage
      const writer = new Repo({
        storage,
        saveDebounceRate: 1,
      })
      const storedHandle = writer.create<TestDoc>({ foo: "from storage" })
      await writer.flush()

      // Make a slow storage that delays until we call releaseStorageLoad()
      let releaseStorageLoad: (() => void) | undefined
      const slowStorage = {
        load: storage.load.bind(storage),
        save: storage.save.bind(storage),
        remove: storage.remove.bind(storage),
        removeRange: storage.removeRange.bind(storage),
        loadRange: async (keyPrefix: StorageKey) => {
          if (
            keyPrefix[0] === storedHandle.documentId &&
            keyPrefix[1] === "snapshot"
          ) {
            await new Promise<void>(resolve => {
              releaseStorageLoad = resolve
            })
          }
          return storage.loadRange(keyPrefix)
        },
      }

      const alice = new Repo({
        peerId: "alice" as PeerId,
        sharePolicy: async () => true,
      })
      // Bob has the slow storage
      const bob = new Repo({
        storage: slowStorage,
        peerId: "bob" as PeerId,
        sharePolicy: async () => true,
      })

      await connectRepos(alice, bob)

      // It's necessary to find the document on bob as well as Alice. This means
      // that if Bob runs sync without waiting for storage then the sync machinery
      // will notice that Alice is a peer and send her a request, causing Alice to
      // believe that Bob does not have the document.
      const bobProgress = bob.findWithProgress<TestDoc>(storedHandle.url)
      await pause(20)

      const aliceProgress = alice.findWithProgress<TestDoc>(storedHandle.url)
      await pause(20)

      assert.equal(
        aliceProgress.peek().state,
        "loading",
        "Alice's find should stay pending while Bob's storage lookup is pending"
      )

      assert.ok(releaseStorageLoad, "storage lookup should be pending")
      releaseStorageLoad()
      const [aliceHandle, bobHandle] = await Promise.all([
        aliceProgress.whenReady(),
        bobProgress.whenReady(),
      ])
      assert.deepStrictEqual(aliceHandle.doc(), { foo: "from storage" })
      assert.deepStrictEqual(bobHandle.doc(), { foo: "from storage" })
    })

    it("automerge-sync source becomes ready only once heads cover a peer's advertised heads", async () => {
      // We seed Bob's storage with a single-change doc so his outgoing
      // sync message has non-empty heads. That defeats the empty-handle
      // full-doc-send optimization and forces Alice to use bloom-filter
      // sync. With ~1000 missing changes and ~1% bloom false-positive
      // rate Alice's first reply skips a handful of changes Bob actually
      // needs, so the sync source must stay `pending` through at least
      // one follow-up round trip. The exact moment it transitions to
      // `ready` should coincide with Bob's heads covering Alice's.
      const storage = new DummyStorageAdapter()

      // Seed Bob's storage with a 1-change doc.
      const writer = new Repo({ storage, saveDebounceRate: 1 })
      const writerHandle = writer.create<TestDoc>({ foo: "seed" })
      await writer.flush()
      const url = writerHandle.url
      const documentId = writerHandle.documentId
      const seedBinary = A.save(writerHandle.doc())

      // Build the full doc on top of the seed: ~1000 additional changes.
      let fullDoc = A.load<TestDoc>(seedBinary)
      for (let i = 0; i < 1000; i++) {
        fullDoc = A.change(fullDoc, d => {
          d.foo = `change-${i}`
        })
      }
      const finalHeads = encodeHeads(A.getHeads(fullDoc))

      // Alice has the full doc; Bob has only the seed in storage.
      // Alice's announce policy is `false` so she won't proactively send
      // a sync message on connect.
      const alice = new Repo({
        peerId: "alice" as PeerId,
        shareConfig: {
          announce: async () => false,
          access: async () => true,
        },
      })
      alice.import<TestDoc>(A.save(fullDoc), { docId: documentId })

      const bob = new Repo({
        storage,
        peerId: "bob" as PeerId,
        sharePolicy: async () => true,
      })

      await connectRepos(alice, bob)

      const progress = bob.findWithProgress<TestDoc>(url)

      const headsWhenSyncReady = await new Promise<UrlHeads>(
        (resolve, reject) => {
          const timer = setTimeout(
            () =>
              reject(new Error("automerge-sync did not become ready in time")),
            5000
          )
          const check = (state: ReturnType<typeof progress.peek>) => {
            if (
              state.sources["automerge-sync"] === "ready" &&
              state.state === "ready"
            ) {
              clearTimeout(timer)
              unsub()
              resolve(state.handle.heads())
              return true
            }
            return false
          }
          const unsub = progress.subscribe(check)
          if (check(progress.peek())) return
        }
      )

      assert.deepStrictEqual(headsWhenSyncReady, finalHeads)
    })

    it("charlieRepo doesn't have a document it's not supposed to have", async () => {
      const { aliceRepo, bobRepo, charlieRepo, notForCharlie, teardown } =
        await setup()

      await Promise.all([
        eventPromise(bobRepo.networkSubsystem, "message"),
        eventPromise(charlieRepo.networkSubsystem, "message"),
      ])

      assert.notEqual(aliceRepo.handles[notForCharlie], undefined, "alice yes")
      assert.notEqual(bobRepo.handles[notForCharlie], undefined, "bob yes")
      assert.equal(charlieRepo.handles[notForCharlie], undefined, "charlie no")

      teardown()
    })

    it("charlieRepo can request a document not initially shared with it", async () => {
      const { charlieRepo, notForCharlie, teardown } = await setup()

      const handle = await charlieRepo.find<TestDoc>(notForCharlie)
      const doc = handle.doc()

      assert.deepStrictEqual(doc, { foo: "baz" })

      teardown()
    })

    it("charlieRepo can request a document across a network of multiple peers", async () => {
      const { charlieRepo, notForBob, teardown } = await setup()

      const handle = await charlieRepo.find<TestDoc>(notForBob)

      await pause(50)

      const doc = handle.doc()
      assert.deepStrictEqual(doc, { foo: "bap" })

      teardown()
    })

    it("doesn't find a document which doesn't exist anywhere on the network", async () => {
      const { charlieRepo, teardown } = await setup()
      const url = generateAutomergeUrl()

      await expect(charlieRepo.find<TestDoc>(url)).rejects.toThrow(
        /Document (.*) is unavailable/
      )

      teardown()
    })

    it("a previously unavailable document syncs over the network if a peer with it connects", async () => {
      const {
        charlieRepo,
        notForCharlie,
        aliceRepo,
        teardown,
        connectAliceToBob,
      } = await setup({ connectAlice: false })

      const url = stringifyAutomergeUrl({ documentId: notForCharlie })
      await expect(charlieRepo.find<TestDoc>(url)).rejects.toThrow(
        /Document (.*) is unavailable/
      )

      connectAliceToBob()

      await eventPromise(aliceRepo.networkSubsystem, "peer")

      // Not sure why we need this pause here, but... we do.
      await pause(150)
      const handle = await charlieRepo.find<TestDoc>(url)
      const doc = handle.doc()
      assert.deepStrictEqual(doc, { foo: "baz" })

      // an additional find should also return the correct resolved document
      const handle2 = await charlieRepo.find<TestDoc>(url)
      const doc2 = handle2.doc()
      assert.deepStrictEqual(doc2, { foo: "baz" })

      teardown()
    })

    it("a previously unavailable document syncs if a connected peer obtains it (but doesn't announce it)", async () => {
      const alice = new Repo({
        peerId: "alice" as PeerId,
        shareConfig: {
          announce: async peerId => peerId === "charlie",
          access: async () => true,
        },
      })
      const bob = new Repo({
        peerId: "bob" as PeerId,
        shareConfig: {
          announce: async () => true,
          access: async () => true,
        },
      })
      const charlie = new Repo({
        peerId: "charlie" as PeerId,
        shareConfig: {
          announce: async () => false,
          access: async () => true,
        },
      })
      await connectRepos(alice, bob)

      const charlieHandle = charlie.create({ foo: "bar" })

      // Charlie isn't connected to any peer, so we don't have the document
      await assert.rejects(bob.find(charlieHandle.url))

      // Now, connect charlie to alice
      await connectRepos(alice, charlie)

      // Alice should now find the document
      const aliceHandle = await withTimeout(alice.find(charlieHandle.url), 500)
      assert.deepStrictEqual(aliceHandle.doc(), { foo: "bar" })

      await pause(150) // wait for the sync debounce rate to elapse

      // Bob should now find the document via alice
      const bobHandle = await withTimeout(bob.find(charlieHandle.url), 500)
      assert.deepStrictEqual(bobHandle.doc(), { foo: "bar" })
    })

    it("a previously unavailable document becomes available if the network adapter initially has no peers", async () => {
      // It is possible for a network adapter to be ready without any peer
      // being announced (e.g. the BroadcastChannelNetworkAdapter). In this
      // case attempting to `Repo.find` a document which is not in the storage
      // will result in an unavailable document. If a peer is later announced
      // on the NetworkAdapter we should attempt to sync with the new peer and
      // if the new peer has the document, the DocHandle should eventually
      // transition to "ready"

      // first create a repo with no network adapter and add a document so that
      // we have a storage containing the document to pass to a new repo later
      const storage = new DummyStorageAdapter()
      const isolatedRepo = new Repo({
        storage,
      })
      const unsyncedHandle = isolatedRepo.create<TestDoc>()
      const url = unsyncedHandle.url
      await isolatedRepo.flush()

      // Now create a message channel to connect two repos
      const abChannel = new MessageChannel()
      const { port1: ab, port2: ba } = abChannel

      // Create an empty repo to request the document from
      const a = new Repo({
        network: [new MessageChannelNetworkAdapter(ab)],
        peerId: "a" as PeerId,
        sharePolicy: async () => true,
      })

      await expect(a.find<TestDoc>(url)).rejects.toThrow(
        /Document (.*) is unavailable/
      )

      // Now create a repo pointing at the storage containing the document and
      // connect it to the other end of the MessageChannel
      const b = new Repo({
        storage,
        peerId: "b" as PeerId,
        network: [new MessageChannelNetworkAdapter(ba)],
      })

      // We need a proper peer status API so we can tell when the
      // peer is connected. For now we just wait a bit.
      await pause(50)

      // The empty repo should be notified of the new peer, send it a request
      // and eventually resolve the handle to "READY"
      const handle = await a.find<TestDoc>(url)
      expect(A.getHeads(handle.doc()).length).toBeGreaterThan(0)
    })

    it("a deleted document from charlieRepo can be refetched", async () => {
      const { charlieRepo, aliceHandle, teardown } = await setup()

      const deletePromise = eventPromise(charlieRepo, "delete-document")
      charlieRepo.delete(aliceHandle.documentId)
      await deletePromise

      const changePromise = eventPromise(aliceHandle, "change")
      aliceHandle.change(d => {
        d.foo = "baz"
      })
      await changePromise

      const handle3 = await charlieRepo.find<TestDoc>(aliceHandle.url)
      const doc3 = handle3.doc()

      assert.deepStrictEqual(doc3, { foo: "baz" })

      teardown()
    })

    it("syncs a bunch of changes", async () => {
      const { aliceRepo, bobRepo, charlieRepo, teardown } = await setup()

      // HACK: yield to give repos time to get the one doc that aliceRepo created
      await pause(50)

      for (let i = 0; i < 100; i++) {
        // pick a repo
        const repo = getRandomItem([aliceRepo, bobRepo, charlieRepo])
        const docs = Object.values(repo.handles)
        const doc =
          Math.random() < 0.5
            ? // heads, create a new doc
              repo.create<TestDoc>()
            : // tails, pick a random doc
              (getRandomItem(docs) as DocHandle<TestDoc>)

        // make a random change to it
        doc.change(d => {
          d.foo = Math.random().toString()
        })
      }

      teardown()
    })

    it("can broadcast a message to peers with the correct document only", async () => {
      const { aliceRepo, bobRepo, charlieRepo, notForCharlie, teardown } =
        await setup()

      const data = { presence: "alice" }

      const aliceHandle = await aliceRepo.find<TestDoc>(
        stringifyAutomergeUrl({ documentId: notForCharlie })
      )
      const bobHandle = await bobRepo.find<TestDoc>(
        stringifyAutomergeUrl({ documentId: notForCharlie })
      )

      const charliePromise = new Promise<void>((resolve, reject) => {
        charlieRepo.networkSubsystem.on("message", message => {
          if (
            message.type === "ephemeral" &&
            message.documentId === notForCharlie
          ) {
            reject(new Error("Charlie should not receive this message"))
          }
        })
        setTimeout(resolve, 100)
      })

      aliceHandle.broadcast(data)
      const { message } = await eventPromise(bobHandle, "ephemeral-message")

      assert.deepStrictEqual(message, data)
      assert.equal(charlieRepo.handles[notForCharlie], undefined, "charlie no")

      await charliePromise
      teardown()
    })

    it("should save sync state of other peers", async () => {
      const { bobRepo, teardown, charlieRepo } = await setup({
        connectAlice: false,
      })

      const bobHandle = bobRepo.create<TestDoc>()
      bobHandle.change(d => {
        d.foo = "bar"
      })

      await pause(200)

      // bob should store the sync state of charlie
      const storedSyncState = await bobRepo.storageSubsystem.loadSyncState(
        bobHandle.documentId,
        await charlieRepo!.storageSubsystem.id()
      )
      assert.deepStrictEqual(
        encodeHeads(storedSyncState.sharedHeads),
        bobHandle.heads()
      )

      teardown()
    })

    it("should actively sync imported documents with id", async () => {
      const repo = new Repo()
      const handle = repo.create<TestDoc>()
      handle.change(d => {
        d.foo = "bar"
      })
      const binary = A.save(handle.doc())

      const { bobRepo, teardown, aliceRepo } = await setup({
        connectAlice: true,
      })

      const aliceHandle = aliceRepo.import(binary, { docId: handle.documentId })
      assert.deepStrictEqual(aliceHandle.doc(), { foo: "bar" })

      await pause(200)

      const bobHandle = await bobRepo.find<TestDoc>(handle.documentId)
      assert.deepStrictEqual(bobHandle.doc(), { foo: "bar" })

      teardown()
    })

    it("should actively sync imported documents", async () => {
      const repo = new Repo()
      const handle = repo.create<TestDoc>()
      handle.change(d => {
        d.foo = "bar"
      })
      const binary = A.save(handle.doc())

      const { bobRepo, teardown, aliceRepo } = await setup({
        connectAlice: true,
      })

      const aliceHandle = aliceRepo.import(binary)
      assert.deepStrictEqual(aliceHandle.doc(), { foo: "bar" })

      await pause(200)

      const bobHandle = await bobRepo.find<TestDoc>(aliceHandle.documentId)
      assert.deepStrictEqual(bobHandle.doc(), { foo: "bar" })

      teardown()
    })

    it("should not save sync state of ephemeral peers", async () => {
      const { bobRepo, teardown, charlieRepo } = await setup({
        connectAlice: false,
        isCharlieEphemeral: true,
      })

      const bobHandle = bobRepo.create<TestDoc>()
      bobHandle.change(d => {
        d.foo = "bar"
      })

      await pause(200)

      // bob should not store the sync state for charlie because charly is an ephemeral peer
      const storedSyncState = await bobRepo.storageSubsystem.loadSyncState(
        bobHandle.documentId,
        await charlieRepo!.storageSubsystem.id()
      )
      assert.deepStrictEqual(storedSyncState, undefined)

      teardown()
    })

    it("should load sync state from storage", async () => {
      const { bobRepo, teardown, charlie, charlieRepo, bobStorage, bob } =
        await setup({
          connectAlice: false,
        })

      // create a new doc and count sync messages
      const bobHandle = bobRepo.create<TestDoc>()
      bobHandle.change(d => {
        d.foo = "bar"
      })
      let bobSyncMessages = 0
      bobRepo.networkSubsystem.on("message", message => {
        if (message.type === "sync") {
          bobSyncMessages++
        }
      })
      await pause(500)

      // repo has no stored sync state for charlie so we should see multiple sync messages
      assert.ok(
        bobSyncMessages >= 2,
        `expected >= 2 sync messages, got ${bobSyncMessages}`
      )

      await bobRepo.flush()

      // setup new repo which uses bob's storage
      const bob2Repo = new Repo({
        storage: bobStorage,
        peerId: "bob-2" as PeerId,
      })

      // connnect it with charlie
      const channel = new MessageChannel()
      bob2Repo.networkSubsystem.addNetworkAdapter(
        new MessageChannelNetworkAdapter(channel.port2)
      )
      charlieRepo.networkSubsystem.addNetworkAdapter(
        new MessageChannelNetworkAdapter(channel.port1)
      )

      // lookup doc we've previously created and count the messages
      bob2Repo.find(bobHandle.documentId)
      let bob2SyncMessages = 0
      bob2Repo.networkSubsystem.on("message", message => {
        if (message.type === "sync") {
          bob2SyncMessages++
        }
      })
      await pause(100)

      // repo has stored sync state for charlie so we should see fewer sync messages
      assert.ok(
        bob2SyncMessages <= 2,
        `expected <= 2 sync messages with stored state, got ${bob2SyncMessages}`
      )

      channel.port1.close()
      teardown()
    })

    it("should report the remote heads when they change", async () => {
      const { bobRepo, charlieRepo, teardown } = await setup({
        connectAlice: false,
      })
      const charliedStorageId = await charlieRepo.storageSubsystem.id()

      const handle = bobRepo.create<TestDoc>()
      handle.change(d => {
        d.foo = "bar"
      })

      // pause to let the sync happen
      await pause(50)

      const nextRemoteHeadsPromise = new Promise<{
        storageId: StorageId
        heads: UrlHeads
        timestamp: number
      }>(resolve => {
        handle.on("remote-heads", ({ storageId, heads, timestamp }) => {
          resolve({ storageId, heads, timestamp })
        })
      })

      const charlieHandle = await charlieRepo.find<TestDoc>(handle.url)

      // make a change on charlie
      charlieHandle.change(d => {
        d.foo = "baz"
      })

      // pause to let the sync happen
      await pause(100)

      assert.deepStrictEqual(charlieHandle.heads(), handle.heads())

      const nextRemoteHeads = await nextRemoteHeadsPromise
      assert.deepStrictEqual(nextRemoteHeads.storageId, charliedStorageId)
      assert.deepStrictEqual(nextRemoteHeads.heads, charlieHandle.heads())

      teardown()
    })

    it("can report the connected peers", async () => {
      const { bobRepo, charlieRepo, teardown } = await setup()

      // pause to let the connections happen
      await pause(1)

      assert.deepStrictEqual(bobRepo.peers, ["alice", "charlie"])
      assert.deepStrictEqual(charlieRepo.peers, ["bob"])

      teardown()
    })

    it("does not add duplicate heads-changed listeners", async () => {
      const { aliceRepo, bobRepo, teardown } = await setup()

      const aliceHandle = aliceRepo.create<TestDoc>({ foo: "bar" })
      await pause(10)

      const bobHandle = await bobRepo.find<TestDoc>(aliceHandle.url)
      // 1 save listener + 1 DocumentQuery listener
      assert.equal(bobHandle.listenerCount("heads-changed"), 2)

      teardown()
    })
  })

  describe("with peers (mesh network)", () => {
    const setup = async () => {
      // Set up three repos; connect Alice to Bob, Bob to Charlie, and Alice to Charlie

      const abChannel = new MessageChannel()
      const bcChannel = new MessageChannel()
      const acChannel = new MessageChannel()

      const { port1: ab, port2: ba } = abChannel
      const { port1: bc, port2: cb } = bcChannel
      const { port1: ac, port2: ca } = acChannel

      const aliceRepo = new Repo({
        network: [
          new MessageChannelNetworkAdapter(ab),
          new MessageChannelNetworkAdapter(ac),
        ],
        peerId: "alice" as PeerId,
      })

      const bobRepo = new Repo({
        network: [
          new MessageChannelNetworkAdapter(ba),
          new MessageChannelNetworkAdapter(bc),
        ],
        peerId: "bob" as PeerId,
      })

      const charlieRepo = new Repo({
        network: [
          new MessageChannelNetworkAdapter(ca),
          new MessageChannelNetworkAdapter(cb),
        ],
        peerId: "charlie" as PeerId,
      })

      const teardown = () => {
        abChannel.port1.close()
        bcChannel.port1.close()
        acChannel.port1.close()
      }

      await Promise.all([
        eventPromise(aliceRepo.networkSubsystem, "peer"),
        eventPromise(bobRepo.networkSubsystem, "peer"),
        eventPromise(charlieRepo.networkSubsystem, "peer"),
      ])

      return {
        teardown,
        aliceRepo,
        bobRepo,
        charlieRepo,
      }
    }

    it("can broadcast a message without entering into an infinite loop", async () => {
      const { aliceRepo, bobRepo, charlieRepo, teardown } = await setup()

      const aliceHandle = aliceRepo.create<TestDoc>()

      const bobHandle = await bobRepo.find(aliceHandle.url)
      const charlieHandle = await charlieRepo.find(aliceHandle.url)

      // Alice should not receive her own ephemeral message
      aliceHandle.on("ephemeral-message", () => {
        throw new Error("Alice should not receive her own ephemeral message")
      })

      // Bob and Charlie should receive Alice's ephemeral message
      const bobGotIt = eventPromise(bobHandle, "ephemeral-message")
      const charlieGotIt = eventPromise(charlieHandle, "ephemeral-message")

      // let peers meet and sync up
      await pause(50)

      // Alice sends an ephemeral message
      const message = { foo: "bar" }
      aliceHandle.broadcast(message)

      const [bob, charlie] = await Promise.all([bobGotIt, charlieGotIt])

      assert.deepStrictEqual(bob.message, message)
      assert.deepStrictEqual(charlie.message, message)

      teardown()
    })

    it("notifies peers when a document is cloned", async () => {
      const { bobRepo, charlieRepo, teardown } = await setup()

      const handle = bobRepo.create<TestDoc>()
      handle.change(d => {
        d.foo = "bar"
      })
      const handle2 = bobRepo.clone(handle)

      // pause to let the sync happen
      await pause(50)

      const charlieHandle = await charlieRepo.find(handle2.url)
      assert.deepStrictEqual(charlieHandle.doc(), { foo: "bar" })

      teardown()
    })

    it("notifies peers when a document is merged", async () => {
      const { bobRepo, charlieRepo, teardown } = await setup()

      const handle = bobRepo.create<TestDoc>()
      handle.change(d => {
        d.foo = "bar"
      })
      const handle2 = bobRepo.clone(handle)

      // pause to let the sync happen
      await pause(50)

      const charlieHandle = await charlieRepo.find(handle2.url)
      assert.deepStrictEqual(charlieHandle.doc(), { foo: "bar" })

      // now make a change to doc2 on bobs side and merge it into doc1
      handle2.change(d => {
        d.foo = "baz"
      })
      handle.merge(handle2)

      // wait for the network to do it's thang
      await pause(350)

      assert.deepStrictEqual(charlieHandle.doc(), { foo: "baz" })

      teardown()
    })
  })

  describe("the denylist", () => {
    it("should immediately return an unavailable message in response to a request for a denylisted document", async () => {
      const storage = new DummyStorageAdapter()

      // first create the document in storage
      const dummyRepo = new Repo({ network: [], storage })
      const doc = dummyRepo.create({ foo: "bar" })
      await dummyRepo.flush()

      // Check that the document actually is in storage
      let docId = doc.documentId
      assert(storage.keys().some((k: string) => k.includes(docId)))

      const channel = new MessageChannel()
      const { port1: clientToServer, port2: serverToClient } = channel
      const server = new Repo({
        network: [new MessageChannelNetworkAdapter(serverToClient)],
        storage,
        denylist: [doc.url],
      })
      const client = new Repo({
        network: [new MessageChannelNetworkAdapter(clientToServer)],
      })

      await Promise.all([
        eventPromise(server.networkSubsystem, "peer"),
        eventPromise(client.networkSubsystem, "peer"),
      ])

      await expect(async () => {
        const clientDoc = await client.find(doc.url)
      }).rejects.toThrow(/Document (.*) is unavailable/)

      const openDocs = Object.keys(server.metrics().documents).length
      assert.deepEqual(openDocs, 0)
    })
  })
})

describe("Repo heads-in-URLs functionality", () => {
  const setup = () => {
    const repo = new Repo({})
    const handle = repo.create()
    handle.change((doc: any) => (doc.title = "Hello World"))
    return { repo, handle }
  }

  it("finds a document view by URL with heads", async () => {
    const { repo, handle } = setup()
    const heads = handle.heads()!
    const url = stringifyAutomergeUrl({ documentId: handle.documentId, heads })
    const view = await repo.find(url)
    expect(view.doc()).toEqual({ title: "Hello World" })
  })

  it("returns a view, not the actual handle, when finding by URL with heads", async () => {
    const { repo, handle } = setup()
    const heads = handle.heads()!
    await handle.change((doc: any) => (doc.title = "Changed"))
    const url = stringifyAutomergeUrl({ documentId: handle.documentId, heads })
    const view = await repo.find(url)
    expect(view.doc()).toEqual({ title: "Hello World" })
    expect(handle.doc()).toEqual({ title: "Changed" })
  })

  it("findWithProgress(urlWithHeads) returns view at heads on whenReady", async () => {
    const { repo, handle } = setup()
    const heads = handle.heads()!
    await handle.change((doc: any) => (doc.title = "Changed"))
    const url = stringifyAutomergeUrl({ documentId: handle.documentId, heads })

    const progress = repo.findWithProgress(url)
    const view = await progress.whenReady()
    expect(view.doc()).toEqual({ title: "Hello World" })
    expect(handle.doc()).toEqual({ title: "Changed" })
  })

  it("findWithProgress(urlWithHeads) returns view at heads via peek().handle", async () => {
    const { repo, handle } = setup()
    const heads = handle.heads()!
    const url = stringifyAutomergeUrl({ documentId: handle.documentId, heads })

    const progress = repo.findWithProgress(url)
    await progress.whenReady() // ensure ready
    const peeked = progress.peek()
    expect(peeked.state).toBe("ready")
    if (peeked.state === "ready") {
      expect(peeked.handle.doc()).toEqual({ title: "Hello World" })
      expect(peeked.handle).not.toBe(handle)
    }
  })

  it("changes to a document view do not affect the original", async () => {
    const { repo, handle } = setup()
    const heads = handle.heads()!
    const url = stringifyAutomergeUrl({ documentId: handle.documentId, heads })
    const view = await repo.find(url)
    expect(() =>
      view.change((doc: any) => (doc.title = "Changed in View"))
    ).toThrow()
    expect(handle.doc()).toEqual({ title: "Hello World" })
  })

  it("document views are read-only", async () => {
    const { repo, handle } = setup()
    const heads = handle.heads()!
    const url = stringifyAutomergeUrl({ documentId: handle.documentId, heads })
    const view = await repo.find(url)
    expect(() => view.change((doc: any) => (doc.title = "Changed"))).toThrow()
  })

  it("finds the latest document when given a URL without heads", async () => {
    const { repo, handle } = setup()
    await handle.change((doc: any) => (doc.title = "Changed"))
    const found = await repo.find(handle.url)
    expect(found.doc()).toEqual({ title: "Changed" })
  })

  describe("waits for the requested heads to arrive", () => {
    // Build alice with v1 + v2; seed bob with v1 only. Bob asks for v2;
    // resolution should hang until bob's network sync delivers v2.
    const setupTwoRepos = async () => {
      const alice = new Repo({ peerId: "alice" as PeerId })
      const aliceHandle = alice.create<{ title: string }>()
      aliceHandle.change(d => (d.title = "v1"))
      const v1Binary = await alice.export(aliceHandle.documentId)!
      aliceHandle.change(d => (d.title = "v2"))
      const v2Heads = aliceHandle.heads()!

      const bob = new Repo({ peerId: "bob" as PeerId })
      bob.import<{ title: string }>(v1Binary!, {
        docId: aliceHandle.documentId,
      })

      const urlAtV2 = stringifyAutomergeUrl({
        documentId: aliceHandle.documentId,
        heads: v2Heads,
      })
      return { alice, bob, urlAtV2 }
    }

    it("repo.find(urlWithHeads) does not resolve before heads are present", async () => {
      const { alice, bob, urlAtV2 } = await setupTwoRepos()

      let resolved = false
      const finding = bob.find<{ title: string }>(urlAtV2).then(v => {
        resolved = true
        return v
      })

      // Bob has v1 in storage but not v2. Wait — he should not resolve.
      await pause(50)
      expect(resolved).toBe(false)

      await connectRepos(alice, bob)
      const view = await finding
      expect(view.doc()).toEqual({ title: "v2" })
    })

    it("findWithProgress(urlWithHeads).peek() reports loading until heads arrive", async () => {
      const { alice, bob, urlAtV2 } = await setupTwoRepos()

      const progress = bob.findWithProgress<{ title: string }>(urlAtV2)
      // Even though bob has v1 data, the wrapper should not call this ready.
      await pause(50)
      expect(progress.peek().state).toBe("loading")

      await connectRepos(alice, bob)
      const view = await progress.whenReady()
      expect(view.doc()).toEqual({ title: "v2" })
      expect(progress.peek().state).toBe("ready")
    })
  })

  it("getHeadsFromUrl returns heads array if present or undefined", () => {
    const { repo, handle } = setup()
    const heads = handle.heads()!
    const url = stringifyAutomergeUrl({ documentId: handle.documentId, heads })
    expect(getHeadsFromUrl(url)).toEqual(heads)

    const urlWithoutHeads = generateAutomergeUrl()
    expect(getHeadsFromUrl(urlWithoutHeads)).toBeUndefined()
  })

  it("isValidAutomergeUrl returns true for valid URLs", () => {
    const { repo, handle } = setup()
    const url = generateAutomergeUrl()
    expect(isValidAutomergeUrl(url)).toBe(true)

    const urlWithHeads = stringifyAutomergeUrl({
      documentId: handle.documentId,
      heads: handle.heads()!,
    })
    expect(isValidAutomergeUrl(urlWithHeads)).toBe(true)
  })

  it("isValidAutomergeUrl returns false for invalid URLs", () => {
    const { repo, handle } = setup()
    expect(isValidAutomergeUrl("not a url")).toBe(false)
    expect(isValidAutomergeUrl("automerge:invalidid")).toBe(false)
    expect(isValidAutomergeUrl("automerge:validid#invalidhead")).toBe(false)
  })

  it("parseAutomergeUrl extracts documentId and heads", () => {
    const { repo, handle } = setup()
    const url = stringifyAutomergeUrl({
      documentId: handle.documentId,
      heads: handle.heads()!,
    })
    const parsed = parseAutomergeUrl(url)
    expect(parsed.documentId).toBe(handle.documentId)
    expect(parsed.heads).toEqual(handle.heads())
  })

  it("stringifyAutomergeUrl creates valid URL", () => {
    const { repo, handle } = setup()
    const url = stringifyAutomergeUrl({
      documentId: handle.documentId,
      heads: handle.heads()!,
    })
    expect(isValidAutomergeUrl(url)).toBe(true)
    const parsed = parseAutomergeUrl(url)
    expect(parsed.documentId).toBe(handle.documentId)
    expect(parsed.heads).toEqual(handle.heads())
  })
})

describe("Repo.find() abort behavior", () => {
  it("aborts immediately if signal is already aborted", async () => {
    const repo = new Repo()
    const controller = new AbortController()
    controller.abort()

    await expect(
      repo.find(generateAutomergeUrl(), { signal: controller.signal })
    ).rejects.toThrow(AbortError)
  })

  it("can abort while waiting for ready state", async () => {
    // Create a repo with no network adapters so document can't become ready
    const repo = new Repo()
    const url = generateAutomergeUrl()

    const controller = new AbortController()

    // Start find and abort after a moment
    const findPromise = repo.find(url, { signal: controller.signal })
    controller.abort()

    // Official specification just says to check `reason.name === "AbortError"`
    // Using AbortError promotes correctness across different JS environments and provides a simpler check.
    await expect(findPromise).rejects.toThrow(AbortError)
    await expect(findPromise).rejects.rejects.toHaveProperty(
      "name",
      "AbortError"
    )
    await expect(findPromise).rejects.not.toThrow("unavailable")
  })

  describe("creating a document with a custom ID factory", () => {
    it("creates a document with the custom ID", async () => {
      const id = new Uint8Array("custom-id".split("").map(c => c.charCodeAt(0)))
      const repo = new Repo({
        idFactory: async () => id,
      })
      const handle = await repo.create2()
      expect(handle.documentId).toBe("9HUp4wuzRMx9MRvN4x")
    })

    it("passes the heads of the document to the callback", async () => {
      const id = new Uint8Array("custom-id".split("").map(c => c.charCodeAt(0)))
      let calledHeads: Heads | null = null
      const repo = new Repo({
        idFactory: async (heads: Heads) => {
          calledHeads = heads
          return id
        },
      })
      const handle = await repo.create2()
      const actualHeads = A.getHeads(handle.doc())
      assert.deepStrictEqual(actualHeads, calledHeads)
    })

    it("allows syncing documents with a custom ID", async () => {
      const [aliceToBob, bobToAlice] = DummyNetworkAdapter.createConnectedPair()
      const alice = new Repo({
        peerId: "alice" as PeerId,
        idFactory: async () =>
          new Uint8Array("custom-id".split("").map(c => c.charCodeAt(0))),
        network: [aliceToBob],
      })
      const bob = new Repo({ peerId: "bob" as PeerId, network: [bobToAlice] })
      aliceToBob.peerCandidate("bob" as PeerId)
      bobToAlice.peerCandidate("alice" as PeerId)

      await pause(50)

      const handle = await alice.create2({ foo: "bar" })
      const bobHandle = await bob.find(handle.url)
      assert.deepStrictEqual(bobHandle.doc(), { foo: "bar" })
    })
  })

  describe("emitted metrics", () => {
    async function setup(): Promise<{ alice: Repo; bob: Repo }> {
      const [aliceToBob, bobToAlice] = DummyNetworkAdapter.createConnectedPair()
      const alice = new Repo({
        peerId: "alice" as PeerId,
        network: [aliceToBob],
      })
      const bob = new Repo({ peerId: "bob" as PeerId, network: [bobToAlice] })
      aliceToBob.peerCandidate("bob" as PeerId)
      bobToAlice.peerCandidate("alice" as PeerId)

      await pause(50)

      return { alice, bob }
    }

    it("should emit events for receive sync message", async () => {
      const { alice, bob } = await setup()

      const bobEvents: DocMetrics[] = []
      bob.on("doc-metrics", e => {
        if (e.type === "receive-sync-message") {
          bobEvents.push(e)
        }
      })

      const handle = await alice.create2({ foo: "bar" })
      const bobHandle = await bob.find(handle.url)

      assert.notEqual(bobEvents.length, 0)
      assert(
        bobEvents.every(
          e =>
            e.type === "receive-sync-message" &&
            e.documentId == handle.documentId &&
            e.durationMillis > 0 &&
            e.fromPeer == ("alice" as PeerId)
        )
      )

      await Promise.all([bob.shutdown(), alice.shutdown()])
    })

    it("should emit events for generate sync message", async () => {
      const { alice, bob } = await setup()

      const bobEvents: DocMetrics[] = []
      bob.on("doc-metrics", e => {
        if (e.type === "generate-sync-message") {
          bobEvents.push(e)
        }
      })

      const handle = await alice.create2({ foo: "bar" })
      const bobHandle = await bob.find(handle.url)

      assert.notEqual(bobEvents.length, 0)
      assert(
        bobEvents.every(
          e =>
            e.type === "generate-sync-message" &&
            e.documentId == handle.documentId &&
            e.durationMillis > 0 &&
            e.forPeer == ("alice" as PeerId)
        )
      )

      await Promise.all([bob.shutdown(), alice.shutdown()])
    })

    it("should emit events on compaction", async () => {
      const bob = new Repo({ storage: new DummyStorageAdapter() })
      // Create a doc and change it enough times to trigger compaction
      const doc = bob.create({ foo: "bar" })

      const events: DocMetrics[] = []
      bob.on("doc-metrics", e => {
        if (e.type === "doc-compacted") {
          events.push(e)
        }
      })

      for (let i = 0; i < 1000; i++) {
        doc.change(d => {
          A.splice(d, ["foo"], 0, 1, `${i}`)
        })
      }

      await pause(200)

      assert.notEqual(events.length, 0)
      assert(
        events.every(
          e =>
            e.type === "doc-compacted" &&
            e.documentId == doc.documentId &&
            e.durationMillis > 0
        )
      )

      await bob.shutdown()
    })

    it("should emit events on save since", async () => {
      const bob = new Repo({
        storage: new DummyStorageAdapter(),
        saveDebounceRate: 10,
      })

      const events: DocMetrics[] = []
      bob.on("doc-metrics", e => {
        if (e.type === "doc-saved") {
          events.push(e)
        }
      })

      const doc = bob.create({ foo: "bar" })

      // We have to save, then pause, then save again in order to trigger the
      // initial compaction and then get to the point where the save actually
      // triggers incremental saves rather than compactions. This is because the
      // logic in the storage adapter is designed to initially compact on every
      // change and only start incremental saves as the document gets a little
      // larger.

      // First create enough changes to get past the "always compact" threshold
      for (let i = 0; i < 1000; i++) {
        doc.change(d => {
          A.splice(d, ["foo"], 0, 1, `${i}`)
        })
      }

      // Wait for the debounced save routine to finish
      await pause(20)

      // Now trigger some changes which will cause incremental saves
      for (let i = 0; i < 10; i++) {
        doc.change(d => {
          A.splice(d, ["foo"], 0, 1, `${i}`)
        })
      }

      // Wait for the debounced save routine again
      await pause(20)

      // Now actually test the events we got
      assert.notEqual(events.length, 0)
      assert(
        events.every(
          e =>
            e.type === "doc-saved" &&
            e.documentId == doc.documentId &&
            e.durationMillis > 0 &&
            A.hasHeads(doc.doc(), e.sinceHeads)
        )
      )

      await bob.shutdown()
    })
  })
})

const warn = console.warn
const NO_OP = () => {}

const disableConsoleWarn = () => {
  console.warn = NO_OP
}

const reenableConsoleWarn = () => {
  console.warn = warn
}
