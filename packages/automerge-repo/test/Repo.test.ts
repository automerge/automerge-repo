import { BroadcastChannelNetworkAdapter } from "@automerge/automerge-repo-network-broadcastchannel"
import { MessageChannelNetworkAdapter } from "@automerge/automerge-repo-network-messagechannel"
import assert from "assert"
import * as Uuid from "uuid"
import { describe, it } from "vitest"
import { parseAutomergeUrl } from "../dist/DocUrl.js"
import { READY } from "../src/DocHandle.js"
import { generateAutomergeUrl, stringifyAutomergeUrl } from "../src/DocUrl.js"
import { Repo } from "../src/Repo.js"
import { eventPromise } from "../src/helpers/eventPromise.js"
import { pause, rejectOnTimeout } from "../src/helpers/pause.js"
import {
  AutomergeUrl,
  DocHandle,
  DocumentId,
  PeerId,
  SharePolicy,
} from "../src/index.js"
import { DummyNetworkAdapter } from "./helpers/DummyNetworkAdapter.js"
import { DummyStorageAdapter } from "./helpers/DummyStorageAdapter.js"
import {
  LargeObject,
  generateLargeObject,
} from "./helpers/generate-large-object.js"
import { getRandomItem } from "./helpers/getRandomItem.js"
import { TestDoc } from "./types.js"

describe("Repo", () => {
  describe("single repo", () => {
    const setup = (networkReady = true) => {
      const storageAdapter = new DummyStorageAdapter()
      const networkAdapter = new DummyNetworkAdapter(networkReady)

      const repo = new Repo({
        storage: storageAdapter,
        network: [networkAdapter],
      })
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
      assert.equal(handle.isReady(), true)
    })

    it("can find a document once it's created", () => {
      const { repo } = setup()
      const handle = repo.create<TestDoc>()
      handle.change((d: TestDoc) => {
        d.foo = "bar"
      })

      const handle2 = repo.find(handle.url)
      assert.equal(handle, handle2)
      assert.deepEqual(handle2.docSync(), { foo: "bar" })
    })

    it("can find a document using a legacy UUID (for now)", () => {
      disableConsoleWarn()

      const { repo } = setup()
      const handle = repo.create<TestDoc>()
      handle.change((d: TestDoc) => {
        d.foo = "bar"
      })

      const url = handle.url
      const { binaryDocumentId } = parseAutomergeUrl(url)
      const legacyDocumentId = Uuid.stringify(binaryDocumentId) as AutomergeUrl // a white lie

      const handle2 = repo.find(legacyDocumentId)
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

      assert.equal(v?.foo, "bar")
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
      assert.equal(handle.isReady(), false)

      const doc = await handle.doc()
      assert.equal(doc, undefined)
    })

    it("fires an 'unavailable' event when you don't have the document locally and network to connect to", async () => {
      const { repo } = setup()
      const url = generateAutomergeUrl()
      const handle = repo.find<TestDoc>(url)
      assert.equal(handle.isReady(), false)

      await eventPromise(handle, "unavailable")
    })

    it("doesn't mark a document as unavailable until network adapters are ready", async () => {
      const { repo, networkAdapter } = setup(false)
      const url = generateAutomergeUrl()
      const handle = repo.find<TestDoc>(url)

      let wasUnavailable = false
      handle.on("unavailable", () => {
        wasUnavailable = true
      })
      await pause(50)
      assert.equal(wasUnavailable, false)

      networkAdapter.emit("ready", { network: networkAdapter })
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
        network: [],
      })

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

      await pause()

      const repo2 = new Repo({
        storage: storageAdapter,
        network: [],
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

      // const bobHandle = repo.find<TestDoc>(handle.url)

      // await assert.rejects(
      //   rejectOnTimeout(bobHandle.doc(), 10),
      //   "document should have been deleted"
      // )

      // assert(!bobHandle.isReady())
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

      // const bobHandle = repo.find<TestDoc>(handle.url)
      // await assert.rejects(
      //   rejectOnTimeout(bobHandle.doc(), 10),
      //   "document should have been deleted"
      // )

      // assert(!bobHandle.isReady())
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

    it("storage state doesn't change across reloads when the document hasn't changed", async () => {
      const storage = new DummyStorageAdapter()

      const repo = new Repo({
        storage,
        network: [],
      })

      const handle = repo.create<{ count: number }>()

      handle.change(d => {
        d.count = 0
      })
      handle.change(d => {
        d.count = 1
      })

      const initialKeys = storage.keys()

      const repo2 = new Repo({
        storage,
        network: [],
      })
      const handle2 = repo2.find(handle.url)
      await handle2.doc()

      assert.deepEqual(storage.keys(), initialKeys)
    })

    it("doesn't delete a document from storage when we refresh", async () => {
      const storage = new DummyStorageAdapter()

      const repo = new Repo({
        storage,
        network: [],
      })

      const handle = repo.create<{ count: number }>()

      handle.change(d => {
        d.count = 0
      })
      handle.change(d => {
        d.count = 1
      })

      for (let i = 0; i < 3; i++) {
        const repo2 = new Repo({
          storage,
          network: [],
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

      const storageKeyTypes = storageAdapter.keys().map(k => k.split(".")[1])
      assert(storageKeyTypes.filter(k => k === "snapshot").length === 1)
    })
  })

  describe("sync", async () => {
    const charlieExcludedDocuments: DocumentId[] = []
    const bobExcludedDocuments: DocumentId[] = []

    const sharePolicy: SharePolicy = async (peerId, documentId) => {
      if (documentId === undefined) return false

      // make sure that charlie never gets excluded documents
      if (charlieExcludedDocuments.includes(documentId) && peerId === "charlie")
        return false

      // make sure that bob never gets excluded documents
      if (bobExcludedDocuments.includes(documentId) && peerId === "bob")
        return false

      return true
    }

    const setupRepos = (connectAlice = true) => {
      // Set up three repos; connect Alice to Bob, and Bob to Charlie

      const aliceBobChannel = new MessageChannel()
      const bobCharlieChannel = new MessageChannel()

      const { port1: aliceToBob, port2: bobToAlice } = aliceBobChannel
      const { port1: bobToCharlie, port2: charlieToBob } = bobCharlieChannel

      const aliceNetworkAdapter = new MessageChannelNetworkAdapter(aliceToBob)

      const aliceRepo = new Repo({
        network: connectAlice ? [aliceNetworkAdapter] : [],
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

      const teardown = () => {
        aliceBobChannel.port1.close()
        bobCharlieChannel.port1.close()
      }

      function doConnectAlice() {
        aliceRepo.networkSubsystem.addNetworkAdapter(
          new MessageChannelNetworkAdapter(aliceToBob)
        )
        //bobRepo.networkSubsystem.addNetworkAdapter(new MessageChannelNetworkAdapter(bobToAlice))
      }

      if (connectAlice) {
        doConnectAlice()
      }

      return {
        teardown,
        aliceRepo,
        bobRepo,
        charlieRepo,
        connectAliceToBob: doConnectAlice,
      }
    }

    const setup = async (connectAlice = true) => {
      const { teardown, aliceRepo, bobRepo, charlieRepo, connectAliceToBob } =
        setupRepos(connectAlice)

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
        aliceRepo,
        bobRepo,
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

      const handle = charlieRepo.find<TestDoc>(
        stringifyAutomergeUrl({ documentId: notForCharlie })
      )
      const doc = await handle.doc()

      assert.deepStrictEqual(doc, { foo: "baz" })

      teardown()
    })

    it("charlieRepo can request a document across a network of multiple peers", async () => {
      const { charlieRepo, notForBob, teardown } = await setup()

      const handle = charlieRepo.find<TestDoc>(
        stringifyAutomergeUrl({ documentId: notForBob })
      )
      const doc = await handle.doc()
      assert.deepStrictEqual(doc, { foo: "bap" })

      teardown()
    })

    it("doesn't find a document which doesn't exist anywhere on the network", async () => {
      const { charlieRepo } = await setup()
      const url = generateAutomergeUrl()
      const handle = charlieRepo.find<TestDoc>(url)
      assert.equal(handle.isReady(), false)

      const doc = await handle.doc()
      assert.equal(doc, undefined)
    })

    it("fires an 'unavailable' event when a document is not available on the network", async () => {
      const { charlieRepo } = await setup()
      const url = generateAutomergeUrl()
      const handle = charlieRepo.find<TestDoc>(url)
      assert.equal(handle.isReady(), false)

      await Promise.all([
        eventPromise(handle, "unavailable"),
        eventPromise(charlieRepo, "unavailable-document"),
      ])

      // make sure it fires a second time if the doc is still unavailable
      const handle2 = charlieRepo.find<TestDoc>(url)
      assert.equal(handle2.isReady(), false)
      await eventPromise(handle2, "unavailable")
    })

    it("a previously unavailable document syncs over the network if a peer with it connects", async () => {
      const {
        charlieRepo,
        notForCharlie,
        aliceRepo,
        teardown,
        connectAliceToBob,
      } = await setup(false)

      const url = stringifyAutomergeUrl({ documentId: notForCharlie })
      const handle = charlieRepo.find<TestDoc>(url)
      assert.equal(handle.isReady(), false)

      await eventPromise(handle, "unavailable")

      connectAliceToBob()

      await eventPromise(aliceRepo.networkSubsystem, "peer")

      const doc = await handle.doc([READY])
      assert.deepStrictEqual(doc, { foo: "baz" })

      // an additional find should also return the correct resolved document
      const handle2 = charlieRepo.find<TestDoc>(url)
      const doc2 = await handle2.doc()
      assert.deepStrictEqual(doc2, { foo: "baz" })

      teardown()
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

    const setupMeshNetwork = async () => {
      const aliceRepo = new Repo({
        network: [new BroadcastChannelNetworkAdapter()],
        peerId: "alice" as PeerId,
      })

      const bobRepo = new Repo({
        network: [new BroadcastChannelNetworkAdapter()],
        peerId: "bob" as PeerId,
      })

      const charlieRepo = new Repo({
        network: [new BroadcastChannelNetworkAdapter()],
        peerId: "charlie" as PeerId,
      })

      // pause to let the network set up
      await pause(50)

      return {
        aliceRepo,
        bobRepo,
        charlieRepo,
      }
    }

    it.only("can emit an 'unavailable' event when it's not found on the network", async () => {
      const { charlieRepo } = await setupMeshNetwork()

      const url = generateAutomergeUrl()
      const handle = charlieRepo.find<TestDoc>(url)
      assert.equal(handle.isReady(), false)

      await eventPromise(handle, "unavailable")
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

      await pause(50)

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

    it("can broadcast a message without entering into an infinite loop", async () => {
      const { aliceRepo, bobRepo, charlieRepo } = await setupMeshNetwork()

      const message = { presence: "alex" }

      const aliceHandle = aliceRepo.create<TestDoc>()

      const bobHandle = bobRepo.find(aliceHandle.url)
      const charlieHandle = charlieRepo.find(aliceHandle.url)

      const aliceDoesntGetIt = new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          resolve()
        }, 100)

        aliceHandle.on("ephemeral-message", () => {
          reject(new Error("alice got the message"))
        })
      })

      const bobGotIt = eventPromise(bobHandle, "ephemeral-message")
      const charlieGotIt = eventPromise(charlieHandle, "ephemeral-message")

      // let things get in sync and peers meet one another
      await pause(50)
      aliceHandle.broadcast(message)

      const [bob, charlie] = await Promise.all([
        bobGotIt,
        charlieGotIt,
        aliceDoesntGetIt,
      ])

      assert.deepStrictEqual(bob.message, message)
      assert.deepStrictEqual(charlie.message, message)
    })

    it("notifies peers when a document is cloned", async () => {
      const { bobRepo, charlieRepo } = await setupMeshNetwork()

      // pause to let the network set up
      await pause(50)

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
    })

    it("notifies peers when a document is merged", async () => {
      const { bobRepo, charlieRepo } = await setupMeshNetwork()

      // pause to let the network set up
      await pause(50)

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
      await pause(50)

      await charlieHandle.doc()
      assert.deepStrictEqual(charlieHandle.docSync(), { foo: "baz" })
    })
  })
})

const disableConsoleWarn = () => {
  console["_warn"] = console.warn
  console.warn = () => {}
}

const reenableConsoleWarn = () => {
  console.warn = console["_warn"]
}
