import assert from "assert"
import { MessageChannelNetworkAdapter } from "@automerge/automerge-repo-network-messagechannel"

import { ChannelId, DocHandle, DocumentId, PeerId, SharePolicy } from "../src"
import { eventPromise } from "../src/helpers/eventPromise.js"
import { pause, rejectOnTimeout } from "../src/helpers/pause.js"
import { Repo } from "../src/Repo.js"
import { DummyNetworkAdapter } from "./helpers/DummyNetworkAdapter.js"
import { DummyStorageAdapter } from "./helpers/DummyStorageAdapter.js"
import { getRandomItem } from "./helpers/getRandomItem.js"
import { TestDoc } from "./types.js"

describe("Repo", () => {
  describe("single repo", () => {
    const setup = () => {
      const storageAdapter = new DummyStorageAdapter()

      const repo = new Repo({
        storage: storageAdapter,
        network: [new DummyNetworkAdapter()],
      })
      return { repo, storageAdapter }
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

    it("doesn't find a document that doesn't exist", async () => {
      const { repo } = setup()
      const handle = repo.find<TestDoc>("does-not-exist" as DocumentId)
      assert.equal(handle.isReady(), false)

      return assert.rejects(
        rejectOnTimeout(handle.doc(), 10),
        "This document should not exist"
      )
    })

    it("can find a created document", async () => {
      const { repo } = setup()
      const handle = repo.create<TestDoc>()
      handle.change(d => {
        d.foo = "bar"
      })
      assert.equal(handle.isReady(), true)

      const bobHandle = repo.find<TestDoc>(handle.documentId)

      assert.equal(handle, bobHandle)
      assert.equal(handle.isReady(), true)

      const v = await bobHandle.doc()
      assert.equal(v.foo, "bar")
    })

    it("saves the document when changed and can find it again", async () => {
      const { repo, storageAdapter } = setup()
      const handle = repo.create<TestDoc>()

      handle.change(d => {
        d.foo = "bar"
      })

      assert.equal(handle.isReady(), true)

      await pause()

      const repo2 = new Repo({
        storage: storageAdapter,
        network: [],
      })

      const bobHandle = repo2.find<TestDoc>(handle.documentId)

      const v = await bobHandle.doc()
      assert.equal(v.foo, "bar")
    })

    it("can delete an existing document", async () => {
      const { repo } = setup()
      const handle = repo.create<TestDoc>()
      handle.change(d => {
        d.foo = "bar"
      })
      assert.equal(handle.isReady(), true)
      await handle.doc()
      repo.delete(handle.documentId)

      assert(handle.isDeleted())
      assert.equal(repo.handles[handle.documentId], undefined)

      const bobHandle = repo.find<TestDoc>(handle.documentId)
      await assert.rejects(
        rejectOnTimeout(bobHandle.doc(), 10),
        "document should have been deleted"
      )

      assert(!bobHandle.isReady())
    })

    it("deleting a document emits an event", async done => {
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
    })
  })

  describe("sync", async () => {
    const setup = async () => {
      // Set up three repos; connect Alice to Bob, and Bob to Charlie

      const aliceBobChannel = new MessageChannel()
      const bobCharlieChannel = new MessageChannel()

      const { port1: aliceToBob, port2: bobToAlice } = aliceBobChannel
      const { port1: bobToCharlie, port2: charlieToBob } = bobCharlieChannel

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

        // make sure that charlie never gets excluded documents
        if (bobExcludedDocuments.includes(documentId) && peerId === "bob")
          return false

        return true
      }

      const aliceRepo = new Repo({
        network: [new MessageChannelNetworkAdapter(aliceToBob)],
        peerId: "alice" as PeerId,
        sharePolicy,
      })

      const bobRepo = new Repo({
        network: [
          new MessageChannelNetworkAdapter(bobToAlice),
          new MessageChannelNetworkAdapter(bobToCharlie),
        ],
        peerId: "bob" as PeerId,
        sharePolicy,
      })

      const charlieRepo = new Repo({
        network: [new MessageChannelNetworkAdapter(charlieToBob)],
        peerId: "charlie" as PeerId,
      })

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
        eventPromise(aliceRepo.networkSubsystem, "peer"),
        eventPromise(bobRepo.networkSubsystem, "peer"),
        eventPromise(charlieRepo.networkSubsystem, "peer"),
      ])

      const teardown = () => {
        aliceBobChannel.port1.close()
        bobCharlieChannel.port1.close()
      }

      return {
        aliceRepo,
        bobRepo,
        charlieRepo,
        aliceHandle,
        notForCharlie,
        notForBob,
        teardown,
      }
    }

    it("changes are replicated from aliceRepo to bobRepo", async () => {
      const { bobRepo, aliceHandle, teardown } = await setup()

      const bobHandle = bobRepo.find<TestDoc>(aliceHandle.documentId)
      await eventPromise(bobHandle, "change")
      const bobDoc = await bobHandle.doc()
      assert.deepStrictEqual(bobDoc, { foo: "bar" })
      teardown()
    })

    it("can load a document from aliceRepo on charlieRepo", async () => {
      const { charlieRepo, aliceHandle, teardown } = await setup()

      const handle3 = charlieRepo.find<TestDoc>(aliceHandle.documentId)
      await eventPromise(handle3, "change")
      const doc3 = await handle3.doc()
      assert.deepStrictEqual(doc3, { foo: "bar" })
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
      const doc = await handle.doc()

      assert.deepStrictEqual(doc, { foo: "baz" })

      teardown()
    })

    it("charlieRepo can request a document across a network of multiple peers", async () => {
      const { charlieRepo, notForBob, teardown } = await setup()

      const handle = charlieRepo.find<TestDoc>(notForBob)
      const doc = await handle.doc()
      assert.deepStrictEqual(doc, { foo: "bap" })

      teardown()
    })

    it("doesn't find a document which doesn't exist anywhere on the network", async () => {
      const { charlieRepo } = await setup()
      const handle = charlieRepo.find<TestDoc>("does-not-exist" as DocumentId)
      assert.equal(handle.isReady(), false)

      return assert.rejects(
        rejectOnTimeout(handle.doc(), 10),
        "This document should not exist"
      )
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

      const handle3 = charlieRepo.find<TestDoc>(aliceHandle.documentId)
      await eventPromise(handle3, "change")
      const doc3 = await handle3.doc()

      assert.deepStrictEqual(doc3, { foo: "baz" })

      teardown()
    })

    it("can broadcast a message", async () => {
      const { aliceRepo, bobRepo, teardown } = await setup()

      const channelId = "broadcast" as ChannelId
      const data = { presence: "bob" }

      bobRepo.ephemeralData.broadcast(channelId, data)
      const d = await eventPromise(aliceRepo.ephemeralData, "data")

      assert.deepStrictEqual(d.data, data)
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
      await pause(500)

      teardown()
    })
  })
})
