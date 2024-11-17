import { next as A } from "@automerge/automerge"
import { MessageChannelNetworkAdapter } from "../../automerge-repo-network-messagechannel/src/index.js"
import assert from "assert"
import * as Uuid from "uuid"
import { describe, expect, it } from "vitest"
import { parseAutomergeUrl } from "../src/AutomergeUrl.js"
import {
  generateAutomergeUrl,
  stringifyAutomergeUrl,
} from "../src/AutomergeUrl.js"
import { Repo, SyncPolicy } from "../src/Repo.js"
import { eventPromise } from "../src/helpers/eventPromise.js"
import { pause } from "../src/helpers/pause.js"
import {
  AnyDocumentId,
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
import { getRandomItem } from "./helpers/getRandomItem.js"
import { TestDoc } from "./types.js"
import { StorageId, StorageKey } from "../src/storage/types.js"

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

      const repo = new Repo({
        storage: storageAdapter,
        network: [networkAdapter],
      })
      repo.saveDebounceRate = 1
      return { repo, storageAdapter, networkAdapter }
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
      assert.equal(
        handle.isReady(),
        true,
        `handle is in ${handle.state}, not ready`
      )
    })

    it("can create a document with an initial value", async () => {
      const { repo } = setup()
      const handle = repo.create({ foo: "bar" })
      await handle.doc()
      assert.equal(handle.docSync().foo, "bar")
    })

    it("can find a document by url", () => {
      const { repo } = setup()
      const handle = repo.create<TestDoc>()
      handle.change((d: TestDoc) => {
        d.foo = "bar"
      })

      const handle2 = repo.find(handle.url)
      assert.equal(handle, handle2)
      assert.deepEqual(handle2.docSync(), { foo: "bar" })
    })

    it("can find a document by its unprefixed document ID", () => {
      const { repo } = setup()
      const handle = repo.create<TestDoc>()
      handle.change((d: TestDoc) => {
        d.foo = "bar"
      })

      const handle2 = repo.find(handle.documentId)
      assert.equal(handle, handle2)
      assert.deepEqual(handle2.docSync(), { foo: "bar" })
    })

    it("can find a document by legacy UUID (for now)", () => {
      disableConsoleWarn()

      const { repo } = setup()
      const handle = repo.create<TestDoc>()
      handle.change((d: TestDoc) => {
        d.foo = "bar"
      })

      const url = handle.url
      const { binaryDocumentId } = parseAutomergeUrl(url)
      const legacyDocId = Uuid.stringify(binaryDocumentId) as LegacyDocumentId

      const handle2 = repo.find(legacyDocId)
      assert.equal(handle, handle2)
      assert.deepEqual(handle2.docSync(), { foo: "bar" })

      reenableConsoleWarn()
    })

    it("can change a document", async () => {
      const { repo } = setup()
      const handle = repo.create<TestDoc>()
      handle.change(d => {
        d.foo = "bar"
      })
      const v = await handle.doc()
      assert.equal(handle.isReady(), true)
      assert.equal(v.foo, "bar")
    })

    it("can clone a document", () => {
      const { repo } = setup()
      const handle = repo.create<TestDoc>()
      handle.change(d => {
        d.foo = "bar"
      })
      const handle2 = repo.clone(handle)
      assert.equal(handle2.isReady(), true)
      assert.notEqual(handle.documentId, handle2.documentId)
      assert.deepStrictEqual(handle.docSync(), handle2.docSync())
      assert.deepStrictEqual(handle2.docSync(), { foo: "bar" })
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

      assert.notDeepStrictEqual(handle.docSync(), handle2.docSync())
      assert.deepStrictEqual(handle.docSync(), { foo: "bar", bar: "bif" })
      assert.deepStrictEqual(handle2.docSync(), { foo: "bar", baz: "baz" })
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

      assert.deepStrictEqual(handle.docSync(), {
        foo: "bar",
        bar: "bif",
        baz: "baz",
      })
      // only the one handle should be changed
      assert.deepStrictEqual(handle2.docSync(), { foo: "bar", baz: "baz" })
    })

    it("throws an error if we try to find a handle with an invalid AutomergeUrl", async () => {
      const { repo } = setup()
      try {
        repo.find<TestDoc>("invalid-url" as unknown as AutomergeUrl)
      } catch (e: any) {
        assert.equal(e.message, "Invalid AutomergeUrl: 'invalid-url'")
      }
    })

    it("doesn't find a document that doesn't exist", async () => {
      const { repo } = setup()
      const handle = repo.find<TestDoc>(generateAutomergeUrl())

      await handle.whenReady(["ready", "unavailable"])

      assert.equal(handle.isReady(), false)
      assert.equal(handle.state, "unavailable")
      const doc = await handle.doc()
      assert.equal(doc, undefined)
    })

    it("emits an unavailable event when you don't have the document locally and are not connected to anyone", async () => {
      const { repo } = setup()
      const url = generateAutomergeUrl()
      const handle = repo.find<TestDoc>(url)
      assert.equal(handle.isReady(), false)
      await eventPromise(handle, "unavailable")
    })

    it("doesn't mark a document as unavailable until network adapters are ready", async () => {
      const { repo, networkAdapter } = setup({ startReady: false })
      const url = generateAutomergeUrl()
      const handle = repo.find<TestDoc>(url)

      let wasUnavailable = false
      handle.on("unavailable", () => {
        wasUnavailable = true
      })

      await pause(50)
      assert.equal(wasUnavailable, false)

      networkAdapter.forceReady()
      await eventPromise(handle, "unavailable")
    })

    it("can find a created document", async () => {
      const { repo } = setup()
      const handle = repo.create<TestDoc>()
      handle.change(d => {
        d.foo = "bar"
      })
      assert.equal(handle.isReady(), true)

      const bobHandle = repo.find<TestDoc>(handle.url)

      assert.equal(handle, bobHandle)
      assert.equal(handle.isReady(), true)

      const v = await bobHandle.doc()
      assert.equal(v?.foo, "bar")
    })

    it("saves the document when creating it", async () => {
      const { repo, storageAdapter } = setup()
      const handle = repo.create<TestDoc>()

      const repo2 = new Repo({
        storage: storageAdapter,
      })

      await repo.flush()

      const bobHandle = repo2.find<TestDoc>(handle.url)
      await bobHandle.whenReady()
      assert.equal(bobHandle.isReady(), true)
    })

    it("saves the document when changed and can find it again", async () => {
      const { repo, storageAdapter } = setup()
      const handle = repo.create<TestDoc>()

      handle.change(d => {
        d.foo = "bar"
      })

      assert.equal(handle.isReady(), true)

      await repo.flush()

      const repo2 = new Repo({
        storage: storageAdapter,
      })

      const bobHandle = repo2.find<TestDoc>(handle.url)

      const v = await bobHandle.doc()
      assert.equal(v?.foo, "bar")
    })

    it("can delete an existing document", async () => {
      const { repo } = setup()
      const handle = repo.create<TestDoc>()
      handle.change(d => {
        d.foo = "bar"
      })
      // we now have a snapshot and an incremental change in storage
      assert.equal(handle.isReady(), true)
      const foo = await handle.doc()
      assert.equal(foo?.foo, "bar")

      await pause()
      repo.delete(handle.documentId)

      assert(handle.isDeleted())
      assert.equal(repo.handles[handle.documentId], undefined)
    })

    it("can delete an existing document by url", async () => {
      const { repo } = setup()
      const handle = repo.create<TestDoc>()
      handle.change(d => {
        d.foo = "bar"
      })
      assert.equal(handle.isReady(), true)
      await handle.doc()

      await pause()
      repo.delete(handle.url)

      assert(handle.isDeleted())
      assert.equal(repo.handles[handle.documentId], undefined)
    })

    it("deleting a document emits an event", async () =>
      new Promise<void>(done => {
        const { repo } = setup()
        const handle = repo.create<TestDoc>()
        handle.change(d => {
          d.foo = "bar"
        })
        assert.equal(handle.isReady(), true)

        repo.on("delete-document", ({ documentId }) => {
          assert.equal(documentId, handle.documentId)

          done()
        })

        repo.delete(handle.documentId)
      }))

    it("exports a document", async () => {
      const { repo } = setup()
      const handle = repo.create<TestDoc>()
      handle.change(d => {
        d.foo = "bar"
      })
      assert.equal(handle.isReady(), true)

      const exported = await repo.export(handle.documentId)
      const loaded = A.load(exported)
      const doc = await handle.doc()
      assert.deepEqual(doc, loaded)
    })

    it("rejects when exporting a document that does not exist", async () => {
      const { repo } = setup()
      assert.rejects(async () => {
        await repo.export("foo" as AnyDocumentId)
      })
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
      const handle2 = repo2.find(handle.url)
      await handle2.doc()

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
        const handle2 = repo2.find(handle.url)
        await handle2.doc()

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

    it("can import an existing document", async () => {
      const { repo } = setup()
      const doc = A.init<TestDoc>()
      const updatedDoc = A.change(doc, d => {
        d.foo = "bar"
      })

      const saved = A.save(updatedDoc)

      const handle = repo.import<TestDoc>(saved)
      assert.equal(handle.isReady(), true)
      const v = await handle.doc()
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
      const doc = await handle.doc()
      expect(doc).toEqual({})
    })

    it("makes an empty document if we try to import a plain object", async () => {
      const { repo } = setup()
      // @ts-ignore - passing something other than UInt8Array
      const handle = repo.import<TestDoc>({ foo: 123 })
      const doc = await handle.doc()
      expect(doc).toEqual({})
    })

    describe("handle cache", () => {
      it("contains doc handle", async () => {
        const { repo } = setup()
        const handle = repo.create({ foo: "bar" })
        await handle.doc()
        assert(repo.handles[handle.documentId])
      })

      it("delete removes doc handle", async () => {
        const { repo } = setup()
        const handle = repo.create({ foo: "bar" })
        await handle.doc()
        await repo.delete(handle.documentId)
        assert(repo.handles[handle.documentId] === undefined)
      })

      it("removeFromCache removes doc handle", async () => {
        const { repo } = setup()
        const handle = repo.create({ foo: "bar" })
        await handle.doc()
        await repo.removeFromCache(handle.documentId)
        assert(repo.handles[handle.documentId] === undefined)
      })

      it("removeFromCache for documentId not found", async () => {
        const { repo } = setup()
        const badDocumentId = "badbadbad" as DocumentId
        const handleCacheSize = Object.keys(repo.handles).length
        await repo.removeFromCache(badDocumentId)
        assert(Object.keys(repo.handles).length === handleCacheSize)
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
      expect((await handle.doc()).foo).toEqual("first")
      expect((await handle2.doc()).foo).toEqual("second")

      // Reload repo
      const repo2 = new Repo({
        storage: pausedStorage,
      })

      // Could not find the document that is not yet saved because of slow storage.
      const reloadedHandle = repo2.find<{ foo: string }>(handle.url)
      expect(pausedStorage.keys()).to.deep.equal([])
      expect(await reloadedHandle.doc()).toEqual(undefined)
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
          (await repo.find<{ foo: string }>(handle.documentId).doc()).foo
        ).toEqual("first")
        expect(
          (await repo.find<{ foo: string }>(handle2.documentId).doc()).foo
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
          (await repo.find<{ foo: string }>(handle.documentId).doc()).foo
        ).toEqual("first")
        // Really, it's okay if the second one is also flushed but I'm forcing the issue
        // in the test storage engine above to make sure the behaviour is as documented
        expect(
          await repo.find<{ foo: string }>(handle2.documentId).doc()
        ).toEqual(undefined)
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
            pair[0].whenReady()
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

      const handleN = repos[numberOfPeers - 1].find<TestDoc>(handle0.url)

      await handleN.whenReady()
      assert.deepStrictEqual(handleN.docSync(), { foo: "bar" })
    })

    const setup = async ({
      connectAlice = true,
      isCharlieEphemeral = false,
      charlieForbiddenDoc = false
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

      const syncPolicy: SyncPolicy = async (peerId, documentId) => {
        if (
          charlieForbiddenDoc &&
          charlieExcludedDocuments.includes(documentId) &&
          peerId === "charlie"
        ) {
          return false
        }

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
        syncPolicy
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
        syncPolicy
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

      const bobHandle = bobRepo.find<TestDoc>(aliceHandle.url)
      await eventPromise(bobHandle, "change")
      const bobDoc = await bobHandle.doc()
      assert.deepStrictEqual(bobDoc, { foo: "bar" })
      teardown()
    })

    it("can load a document from aliceRepo on charlieRepo", async () => {
      const { charlieRepo, aliceHandle, teardown } = await setup()

      const handle3 = charlieRepo.find<TestDoc>(aliceHandle.url)
      await eventPromise(handle3, "change")
      const doc3 = await handle3.doc()
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
      const bobFoundIt = bobRepo.find<TestDoc>(inStorageHandle.url)
      await bobFoundIt.whenReady()

      // Before checking if it syncs, make sure we have it!
      // (This behaviour is mostly test-validation, we are already testing load/save elsewhere.)
      assert.deepStrictEqual(await bobFoundIt.doc(), { foo: "foundOnFakeDisk" })

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

      const handle = charlieRepo.find<TestDoc>(notForCharlie)

      await pause(50)

      const doc = await handle.doc()

      assert.deepStrictEqual(doc, { foo: "baz" })

      teardown()
    })

    it("charlieRepo can't sync with a document when forbidden by syncPolicy", async () => {
      const { charlieRepo, notForCharlie, teardown } = await setup({charlieForbiddenDoc: true})

      const handle = charlieRepo.find<TestDoc>(notForCharlie)

      await pause(50)

      assert(handle.isUnavailable())

      teardown()
    })

    it("charlieRepo can request a document across a network of multiple peers", async () => {
      const { charlieRepo, notForBob, teardown } = await setup()

      const handle = charlieRepo.find<TestDoc>(notForBob)

      await pause(50)

      const doc = await handle.doc()
      assert.deepStrictEqual(doc, { foo: "bap" })

      teardown()
    })

    it("doesn't find a document which doesn't exist anywhere on the network", async () => {
      const { charlieRepo, teardown } = await setup()
      const url = generateAutomergeUrl()
      const handle = charlieRepo.find<TestDoc>(url)
      assert.equal(handle.isReady(), false)

      const doc = await handle.doc()
      assert.equal(doc, undefined)

      teardown()
    })

    it("emits an unavailable event when it's not found on the network", async () => {
      const { aliceRepo, teardown } = await setup()
      const url = generateAutomergeUrl()
      const handle = aliceRepo.find(url)
      assert.equal(handle.isReady(), false)
      await eventPromise(handle, "unavailable")
      teardown()
    })

    it("emits an unavailable event every time an unavailable doc is requested", async () => {
      const { charlieRepo, teardown } = await setup()
      const url = generateAutomergeUrl()
      const handle = charlieRepo.find<TestDoc>(url)
      assert.equal(handle.isReady(), false)

      await Promise.all([
        eventPromise(handle, "unavailable"),
        eventPromise(charlieRepo, "unavailable-document"),
      ])

      // make sure it emits a second time if the doc is still unavailable
      const handle2 = charlieRepo.find<TestDoc>(url)
      assert.equal(handle2.isReady(), false)
      await Promise.all([
        eventPromise(handle, "unavailable"),
        eventPromise(charlieRepo, "unavailable-document"),
      ])

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
      const handle = charlieRepo.find<TestDoc>(url)
      assert.equal(handle.isReady(), false)

      await eventPromise(handle, "unavailable")

      connectAliceToBob()

      await eventPromise(aliceRepo.networkSubsystem, "peer")

      const doc = await handle.doc(["ready"])
      assert.deepStrictEqual(doc, { foo: "baz" })

      // an additional find should also return the correct resolved document
      const handle2 = charlieRepo.find<TestDoc>(url)
      const doc2 = await handle2.doc()
      assert.deepStrictEqual(doc2, { foo: "baz" })

      teardown()
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

      const handle = a.find(url)

      // We expect this to be unavailable as there is no connected peer and
      // the repo has no storage.
      await eventPromise(handle, "unavailable")

      // Now create a repo pointing at the storage containing the document and
      // connect it to the other end of the MessageChannel
      const b = new Repo({
        storage,
        peerId: "b" as PeerId,
        network: [new MessageChannelNetworkAdapter(ba)],
      })

      // The empty repo should be notified of the new peer, send it a request
      // and eventually resolve the handle to "READY"
      await handle.whenReady()
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

      const handle3 = charlieRepo.find<TestDoc>(aliceHandle.url)
      await eventPromise(handle3, "change")
      const doc3 = await handle3.doc()

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

        // make sure the doc is ready
        if (!doc.isReady()) {
          await doc.doc()
        }

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

      const aliceHandle = aliceRepo.find<TestDoc>(
        stringifyAutomergeUrl({ documentId: notForCharlie })
      )
      const bobHandle = bobRepo.find<TestDoc>(
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
      assert.deepStrictEqual(storedSyncState.sharedHeads, bobHandle.heads())

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

      // repo has no stored sync state for charlie so we should see 2 sync messages
      assert.strictEqual(bobSyncMessages, 2)

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

      // repo has stored sync state for charlie so we should see one sync messages
      assert.strictEqual(bob2SyncMessages, 1)

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
        heads: A.Heads
      }>(resolve => {
        handle.on("remote-heads", ({ storageId, heads }) => {
          resolve({ storageId, heads })
        })
      })

      const charlieHandle = charlieRepo.find<TestDoc>(handle.url)
      await charlieHandle.whenReady()

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

      assert.deepStrictEqual(
        handle.getRemoteHeads(charliedStorageId),
        charlieHandle.heads()
      )

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
  })

  it("peer receives a document when connection is recovered", async () => {
    const alice = "alice" as PeerId
    const bob = "bob" as PeerId
    const [aliceAdapter, bobAdapter] = DummyNetworkAdapter.createConnectedPair()
    const aliceRepo = new Repo({
      network: [aliceAdapter],
      peerId: alice,
    })
    const bobRepo = new Repo({
      network: [bobAdapter],
      peerId: bob,
    })
    const aliceDoc = aliceRepo.create()
    aliceDoc.change((doc: any) => (doc.text = "Hello world"))

    const bobDoc = bobRepo.find(aliceDoc.url)
    await eventPromise(bobDoc, "unavailable")

    aliceAdapter.peerCandidate(bob)
    // Bob isn't yet connected to Alice and can't respond to her sync message
    await pause(100)
    bobAdapter.peerCandidate(alice)

    await bobDoc.whenReady()

    assert.equal(bobDoc.isReady(), true)
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

      const bobHandle = bobRepo.find(aliceHandle.url)
      const charlieHandle = charlieRepo.find(aliceHandle.url)

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

      const charlieHandle = charlieRepo.find(handle2.url)
      await charlieHandle.doc()
      assert.deepStrictEqual(charlieHandle.docSync(), { foo: "bar" })

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

      const charlieHandle = charlieRepo.find(handle2.url)
      await charlieHandle.doc()
      assert.deepStrictEqual(charlieHandle.docSync(), { foo: "bar" })

      // now make a change to doc2 on bobs side and merge it into doc1
      handle2.change(d => {
        d.foo = "baz"
      })
      handle.merge(handle2)

      // wait for the network to do it's thang
      await pause(350)

      await charlieHandle.doc()
      assert.deepStrictEqual(charlieHandle.docSync(), { foo: "baz" })

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

      const clientDoc = client.find(doc.url)
      await pause(100)
      assert.strictEqual(clientDoc.docSync(), undefined)

      const openDocs = Object.keys(server.metrics().documents).length
      assert.deepEqual(openDocs, 0)
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
