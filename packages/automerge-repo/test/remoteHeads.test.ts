import { MessageChannelNetworkAdapter } from "@automerge/automerge-repo-network-messagechannel"
import * as A from "@automerge/automerge/next"
import assert from "assert"
import { setTimeout } from "timers/promises"
import { describe, it } from "vitest"
import { generateAutomergeUrl, parseAutomergeUrl } from "../src/AutomergeUrl.js"
import { eventPromise } from "../src/helpers/eventPromise.js"
import {
  DocHandle,
  DocHandleRemoteHeadsPayload,
  PeerId,
  Repo,
} from "../src/index.js"
import { DummyStorageAdapter } from "./helpers/DummyStorageAdapter.js"
import { waitForMessages } from "./helpers/waitForMessages.js"
import { TestDoc } from "./types.js"

describe("DocHandle.remoteHeads", () => {
  const TEST_ID = parseAutomergeUrl(generateAutomergeUrl()).documentId

  it("should allow to listen for remote head changes and manually read remote heads", async () => {
    const handle = new DocHandle<TestDoc>(TEST_ID, { isNew: true })
    const bobRepo = new Repo({
      peerId: "bob" as PeerId,
      network: [],
      storage: new DummyStorageAdapter(),
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
      const leftTab1 = new Repo({
        peerId: "left-tab-1" as PeerId,
        network: [],
        sharePolicy: async () => true,
      })
      const leftTab2 = new Repo({
        peerId: "left-tab-2" as PeerId,
        network: [],
        sharePolicy: async () => true,
      })
      const leftServiceWorker = new Repo({
        peerId: "left-service-worker" as PeerId,
        network: [],
        sharePolicy: async peer => peer === "sync-server",
        storage: new DummyStorageAdapter(),
        isEphemeral: false,
      })
      const syncServer = new Repo({
        peerId: "sync-server" as PeerId,
        network: [],
        isEphemeral: false,
        sharePolicy: async () => false,
        storage: new DummyStorageAdapter(),
      })
      const rightServiceWorker = new Repo({
        peerId: "right-service-worker" as PeerId,
        network: [],
        sharePolicy: async peer => peer === "sync-server",
        isEphemeral: false,
        storage: new DummyStorageAdapter(),
      })
      const rightTab = new Repo({
        peerId: "right-tab" as PeerId,
        network: [],
        sharePolicy: async () => true,
      })

      // connect them all up
      connectRepos(leftTab1, leftServiceWorker)
      connectRepos(leftServiceWorker, syncServer)
      connectRepos(syncServer, rightServiceWorker)
      connectRepos(rightServiceWorker, rightTab)

      await setTimeout(100)

      return {
        leftTab1,
        leftTab2,
        leftServiceWorker,
        syncServer,
        rightServiceWorker,
        rightTab,
      }
    }

    it("should report remoteHeads for peers", async () => {
      const { rightTab, rightServiceWorker, leftServiceWorker, leftTab1 } =
        await setup()

      // subscribe to the left service worker storage ID on the right tab
      rightTab.subscribeToRemotes([await leftServiceWorker.storageId()!])

      await setTimeout(100)

      // create a doc in the left tab
      const leftTabDoc = leftTab1.create<TestDoc>()
      leftTabDoc.change(d => (d.foo = "bar"))

      // wait for the document to arrive on the right tab
      const rightTabDoc = rightTab.find<TestDoc>(leftTabDoc.url)
      await rightTabDoc.whenReady()

      // wait for the document to arrive in the left service worker
      const leftServiceWorkerDoc = leftServiceWorker.find(leftTabDoc.documentId)
      await leftServiceWorkerDoc.whenReady()

      const leftServiceWorkerStorageId = await leftServiceWorker.storageId()
      let leftSeenByRightPromise = new Promise<DocHandleRemoteHeadsPayload>(
        resolve => {
          rightTabDoc.on("remote-heads", message => {
            if (message.storageId === leftServiceWorkerStorageId) {
              resolve(message)
            }
          })
        }
      )

      // make a change on the right
      rightTabDoc.change(d => (d.foo = "baz"))

      // wait for the change to be acknolwedged by the left
      const leftSeenByRight = await leftSeenByRightPromise

      assert.deepStrictEqual(
        leftSeenByRight.heads,
        A.getHeads(leftServiceWorkerDoc.docSync())
      )
    })

    it("should report remoteHeads only for documents the subscriber has open", async () => {
      const { leftTab1, rightTab, rightServiceWorker } = await setup()

      // subscribe leftTab to storageId of rightServiceWorker
      leftTab1.subscribeToRemotes([await rightServiceWorker.storageId()!])

      await setTimeout(100)

      // create 2 docs in right tab
      const rightTabDocA = rightTab.create<TestDoc>()
      rightTabDocA.change(d => (d.foo = "A"))

      const rightTabDocB = rightTab.create<TestDoc>()
      rightTabDocB.change(d => (d.foo = "B"))

      // open doc b in left tab 1
      const leftTabDocA = leftTab1.find<TestDoc>(rightTabDocA.url)

      const remoteHeadsChangedMessages = (
        await waitForMessages(leftTab1.networkSubsystem, "message")
      ).filter(({ type }) => type === "remote-heads-changed")

      // we should only be notified of the head changes of doc A
      assert.strictEqual(remoteHeadsChangedMessages.length, 1)
      assert.strictEqual(
        remoteHeadsChangedMessages[0].documentId,
        leftTabDocA.documentId
      )
    })

    it("should report remote heads for doc on subscribe if peer already knows them", async () => {
      const { leftTab1, leftTab2, rightTab, rightServiceWorker } = await setup()

      // create 2 docs in right tab
      const rightTabDocA = rightTab.create<TestDoc>()
      rightTabDocA.change(d => (d.foo = "A"))

      const rightTabDocB = rightTab.create<TestDoc>()
      rightTabDocB.change(d => (d.foo = "B"))

      // open docs in left tab 1
      const leftTab1DocA = leftTab1.find<TestDoc>(rightTabDocA.url)
      const leftTab1DocB = leftTab1.find<TestDoc>(rightTabDocB.url)

      // subscribe leftTab 1 to storageId of rightServiceWorker
      leftTab1.subscribeToRemotes([await rightServiceWorker.storageId()!])

      await setTimeout(100)

      // now the left service worker has the remote heads of the right service worker for both doc A and doc B
      // if we subscribe from left tab 1 the left service workers should send it's stored remote heads immediately

      // open doc and subscribe leftTab 2 to storageId of rightServiceWorker
      const leftTab2DocA = leftTab1.find<TestDoc>(rightTabDocA.url)
      leftTab2.subscribeToRemotes([await rightServiceWorker.storageId()!])

      const remoteHeadsChangedMessages = (
        await waitForMessages(leftTab2.networkSubsystem, "message")
      ).filter(({ type }) => type === "remote-heads-changed")

      // we should only be notified of the head changes of doc A
      assert.strictEqual(remoteHeadsChangedMessages.length, 1)
      assert.strictEqual(
        remoteHeadsChangedMessages[0].documentId,
        leftTab1DocA.documentId
      )
    })

    it("should report remote heads for subscribed storage id once we open a new doc", async () => {
      const { leftTab1, leftTab2, rightTab, rightServiceWorker } = await setup()

      // create 2 docs in right tab
      const rightTabDocA = rightTab.create<TestDoc>()
      rightTabDocA.change(d => (d.foo = "A"))

      const rightTabDocB = rightTab.create<TestDoc>()
      rightTabDocB.change(d => (d.foo = "B"))

      // subscribe leftTab 1 to storageId of rightServiceWorker
      leftTab1.subscribeToRemotes([await rightServiceWorker.storageId()!])

      await setTimeout(100)

      // in leftTab 1 open doc A
      const leftTab1DocA = leftTab1.find<TestDoc>(rightTabDocA.url)

      const remoteHeadsChangedMessages = (
        await waitForMessages(leftTab2.networkSubsystem, "message")
      ).filter(({ type }) => type === "remote-heads-changed")

      assert.strictEqual(remoteHeadsChangedMessages.length, 1)
      assert.strictEqual(
        remoteHeadsChangedMessages[0].documentId,
        leftTab1DocA.documentId
      )
    })
  })
})

function connectRepos(repo1: Repo, repo2: Repo) {
  const { port1: leftToRight, port2: rightToLeft } = new MessageChannel()

  repo1.networkSubsystem.addNetworkAdapter(
    new MessageChannelNetworkAdapter(leftToRight)
  )
  repo2.networkSubsystem.addNetworkAdapter(
    new MessageChannelNetworkAdapter(rightToLeft)
  )
}
