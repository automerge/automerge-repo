import * as A from "@automerge/automerge/next"
import assert from "assert"
import { describe, it } from "vitest"
import { MessageChannelNetworkAdapter } from "../../automerge-repo-network-messagechannel/dist/index.js"
import { generateAutomergeUrl, parseAutomergeUrl } from "../src/AutomergeUrl.js"
import { eventPromise } from "../src/helpers/eventPromise.js"
import {
  DocHandle,
  DocHandleRemoteHeadsPayload,
  PeerId,
  Repo,
} from "../src/index.js"
import { DummyStorageAdapter } from "./helpers/DummyStorageAdapter.js"
import { collectMessages } from "./helpers/collectMessages.js"
import { TestDoc } from "./types.js"

describe("DocHandle.remoteHeads", () => {
  const TEST_ID = parseAutomergeUrl(generateAutomergeUrl()).documentId

  it("should allow to listen for remote head changes and manually read remote heads", async () => {
    const handle = new DocHandle<TestDoc>(TEST_ID, { isNew: true })
    const bobRepo = new Repo({
      peerId: "bob" as PeerId,
      network: [],
      storage: new DummyStorageAdapter(),
      enableRemoteHeadsGossiping: true,
    })
    const bobStorageId = await bobRepo.storageId()

    const remoteHeadsMessagePromise = eventPromise(handle, "remote-heads")
    handle.setRemoteHeads(bobStorageId, [])

    const remoteHeadsMessage = await remoteHeadsMessagePromise

    assert.strictEqual(remoteHeadsMessage.storageId, bobStorageId)
    assert.deepStrictEqual(remoteHeadsMessage.heads, [])

    // read remote heads manually
    assert.deepStrictEqual(handle.getRemoteHeads(bobStorageId), [])
  })

  describe("multi hop sync", () => {
    async function setup() {
      // setup topology: tab -> service worker -> sync server <- service worker <- tab
      const aliceTab1 = new Repo({
        peerId: "alice-tab-1" as PeerId,
        network: [],
        sharePolicy: async () => true,
        enableRemoteHeadsGossiping: true,
      })
      const aliceTab2 = new Repo({
        peerId: "alice-tab-2" as PeerId,
        network: [],
        sharePolicy: async () => true,
        enableRemoteHeadsGossiping: true,
      })
      const aliceServiceWorker = new Repo({
        peerId: "alice-service-worker" as PeerId,
        network: [],
        sharePolicy: async peer => peer === "sync-server",
        storage: new DummyStorageAdapter(),
        isEphemeral: false,
        enableRemoteHeadsGossiping: true,
      })
      const syncServer = new Repo({
        peerId: "sync-server" as PeerId,
        network: [],
        isEphemeral: false,
        sharePolicy: async () => false,
        storage: new DummyStorageAdapter(),
        enableRemoteHeadsGossiping: true,
      })
      const bobServiceWorker = new Repo({
        peerId: "bob-service-worker" as PeerId,
        network: [],
        sharePolicy: async peer => peer === "sync-server",
        isEphemeral: false,
        storage: new DummyStorageAdapter(),
        enableRemoteHeadsGossiping: true,
      })
      const bobTab = new Repo({
        peerId: "bob-tab" as PeerId,
        network: [],
        sharePolicy: async () => true,
        enableRemoteHeadsGossiping: true,
      })

      // connect them all up
      await Promise.all([
        connectRepos(aliceTab1, aliceServiceWorker),
        connectRepos(aliceTab2, aliceServiceWorker),
        connectRepos(aliceServiceWorker, syncServer),
        connectRepos(syncServer, bobServiceWorker),
        connectRepos(bobServiceWorker, bobTab),
      ])

      const aliceTab1StorageId = await aliceServiceWorker.storageId()
      const aliceTab2StorageId = await aliceServiceWorker.storageId()
      const aliceServiceWorkerStorageId = await aliceServiceWorker.storageId()
      const syncServerStorageId = await syncServer.storageId()
      const bobServiceWorkerStorageId = await bobServiceWorker.storageId()
      const bobTabStorageId = await bobServiceWorker.storageId()

      return {
        aliceTab1,
        aliceTab2,
        aliceServiceWorker,
        syncServer,
        bobServiceWorker,
        bobTab,
        aliceTab1StorageId,
        aliceTab2StorageId,
        aliceServiceWorkerStorageId,
        syncServerStorageId,
        bobServiceWorkerStorageId,
        bobTabStorageId,
      }
    }

    it("should report remoteHeads for peers", async () => {
      const {
        bobTab,
        aliceServiceWorkerStorageId,
        aliceServiceWorker,
        aliceTab1,
      } = await setup()

      // subscribe to the left service worker storage ID on the right tab
      bobTab.subscribeToRemotes([aliceServiceWorkerStorageId])

      // create a doc in the left tab
      const leftTabDoc = aliceTab1.create<TestDoc>()
      leftTabDoc.change(d => (d.foo = "bar"))

      // wait for the document to arrive on the right tab
      const bobTabDoc = bobTab.find<TestDoc>(leftTabDoc.url)
      await bobTabDoc.whenReady()

      // wait for the document to arrive in the left service worker
      const aliceServiceWorkerDoc = aliceServiceWorker.find(
        leftTabDoc.documentId
      )
      await aliceServiceWorkerDoc.whenReady()

      let leftSeenByRightPromise = new Promise<DocHandleRemoteHeadsPayload>(
        resolve => {
          bobTabDoc.on("remote-heads", message => {
            if (message.storageId === aliceServiceWorkerStorageId) {
              resolve(message)
            }
          })
        }
      )

      // make a change on the right
      bobTabDoc.change(d => (d.foo = "baz"))

      // wait for the change to be acknolwedged by the left
      const leftSeenByRight = await leftSeenByRightPromise

      assert.deepStrictEqual(
        leftSeenByRight.heads,
        A.getHeads(aliceServiceWorkerDoc.docSync())
      )
    })

    it("should report remoteHeads only for documents the subscriber has open", async () => {
      const { aliceTab1, bobTab, bobServiceWorkerStorageId } = await setup()

      // subscribe leftTab to storageId of bobServiceWorker
      aliceTab1.subscribeToRemotes([bobServiceWorkerStorageId])

      // create 2 docs in right tab
      const bobTabDocA = bobTab.create<TestDoc>()
      bobTabDocA.change(d => (d.foo = "A"))

      const bobTabDocB = bobTab.create<TestDoc>()
      bobTabDocB.change(d => (d.foo = "B"))

      // open doc b in left tab 1
      const aliceTabDocA = aliceTab1.find<TestDoc>(bobTabDocA.url)

      const remoteHeadsChangedMessages = (
        await collectMessages({
          emitter: aliceTab1.networkSubsystem,
          event: "message",
          until: aliceTabDocA.whenReady(),
        })
      ).filter(({ type }) => type === "remote-heads-changed")

      // we should only be notified of the head changes of doc A
      assert(
        remoteHeadsChangedMessages.every(
          d => d.documentId === aliceTabDocA.documentId
        )
      )
    })

    it("should report remote heads for doc on subscribe if peer already knows them", async () => {
      const { aliceTab1, aliceTab2, bobTab, bobServiceWorkerStorageId } =
        await setup()

      // create 2 docs in right tab
      const bobTabDocA = bobTab.create<TestDoc>()
      bobTabDocA.change(d => (d.foo = "A"))

      const bobTabDocB = bobTab.create<TestDoc>()
      bobTabDocB.change(d => (d.foo = "B"))

      // open docs in left tab 1
      const aliceTab1DocA = aliceTab1.find<TestDoc>(bobTabDocA.url)
      const leftTab1DocB = aliceTab1.find<TestDoc>(bobTabDocB.url)

      // subscribe leftTab 1 to storageId of bobServiceWorker
      aliceTab1.subscribeToRemotes([bobServiceWorkerStorageId])

      // now the left service worker has the remote heads of the right service worker for both doc A and doc B
      // if we subscribe from left tab 1 the left service workers should send it's stored remote heads immediately

      // open doc and subscribe leftTab 2 to storageId of bobServiceWorker
      const aliceTab2DocA = aliceTab2.find<TestDoc>(bobTabDocA.url)
      aliceTab2.subscribeToRemotes([bobServiceWorkerStorageId])

      const remoteHeadsChangedMessages = (
        await collectMessages({
          emitter: aliceTab2.networkSubsystem,
          event: "message",
          until: aliceTab2DocA.whenReady(),
        })
      ).filter(({ type }) => type === "remote-heads-changed")

      // we should only be notified of the head changes of doc A
      assert.strictEqual(remoteHeadsChangedMessages.length, 2)
      assert(
        remoteHeadsChangedMessages.every(
          d => d.documentId === aliceTab2DocA.documentId
        )
      )
    })

    it("should report remote heads for subscribed storage id once we open a new doc", async () => {
      const { aliceTab1, bobTab, bobServiceWorkerStorageId } = await setup()

      // create 2 docs in right tab
      const bobTabDocA = bobTab.create<TestDoc>()
      bobTabDocA.change(d => (d.foo = "A"))

      const bobTabDocB = bobTab.create<TestDoc>()
      bobTabDocB.change(d => (d.foo = "B"))

      // subscribe leftTab 1 to storageId of bobServiceWorker
      aliceTab1.subscribeToRemotes([bobServiceWorkerStorageId])

      // in leftTab 1 open doc A
      const aliceTab1DocA = aliceTab1.find<TestDoc>(bobTabDocA.url)

      const remoteHeadsChangedMessages = (
        await collectMessages({
          emitter: aliceTab1.networkSubsystem,
          event: "message",
          until: aliceTab1DocA.whenReady(),
        })
      ).filter(({ type }) => type === "remote-heads-changed")

      assert.strictEqual(remoteHeadsChangedMessages.length, 2)
      assert(
        remoteHeadsChangedMessages.every(
          d => d.documentId === aliceTab1DocA.documentId
        )
      )
    })
  })
})

async function connectRepos(a: Repo, b: Repo) {
  const { port1: a2b, port2: b2a } = new MessageChannel()
  const aAdapter = new MessageChannelNetworkAdapter(a2b)
  const bAdapter = new MessageChannelNetworkAdapter(b2a)
  a.networkSubsystem.addNetworkAdapter(aAdapter)
  b.networkSubsystem.addNetworkAdapter(bAdapter)
  await Promise.all([
    eventPromise(a.networkSubsystem, "ready"),
    eventPromise(b.networkSubsystem, "ready"),
  ])
}
