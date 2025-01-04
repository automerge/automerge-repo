import * as A from "@automerge/automerge/next"
import assert from "assert"
import { describe, it } from "vitest"
import { MessageChannelNetworkAdapter } from "../../automerge-repo-network-messagechannel/src/index.js"
import { generateAutomergeUrl, parseAutomergeUrl } from "../src/AutomergeUrl.js"
import { eventPromise } from "../src/helpers/eventPromise.js"
import {
  DocHandle,
  DocHandleRemoteHeadsPayload,
  PeerId,
  Repo,
} from "../src/index.js"
import { DummyStorageAdapter } from "../src/helpers/DummyStorageAdapter.js"
import { collectMessages } from "./helpers/collectMessages.js"
import { TestDoc } from "./types.js"
import { pause } from "../src/helpers/pause.js"

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
      // setup topology: alice -> service worker -> sync server <- service worker <- bob
      const alice = new Repo({
        peerId: "alice-tab-1" as PeerId,
        network: [],
        sharePolicy: async () => true,
        enableRemoteHeadsGossiping: true,
      })
      const alice2 = new Repo({
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
      const bob = new Repo({
        peerId: "bob-tab" as PeerId,
        network: [],
        sharePolicy: async () => true,
        enableRemoteHeadsGossiping: true,
      })

      // connect them all up
      await Promise.all([
        connectRepos(alice, aliceServiceWorker),
        connectRepos(alice2, aliceServiceWorker),
        connectRepos(aliceServiceWorker, syncServer),
        connectRepos(syncServer, bobServiceWorker),
        connectRepos(bobServiceWorker, bob),
      ])

      const alice1StorageId = await aliceServiceWorker.storageId()
      const alice2StorageId = await aliceServiceWorker.storageId()
      const aliceServiceWorkerStorageId = await aliceServiceWorker.storageId()
      const syncServerStorageId = await syncServer.storageId()
      const bobServiceWorkerStorageId = await bobServiceWorker.storageId()
      const bobStorageId = await bobServiceWorker.storageId()

      return {
        alice,
        alice2,
        aliceServiceWorker,
        syncServer,
        bobServiceWorker,
        bob,
        alice1StorageId,
        alice2StorageId,
        aliceServiceWorkerStorageId,
        syncServerStorageId,
        bobServiceWorkerStorageId,
        bobStorageId,
      }
    }

    it("should report remoteHeads for peers", async () => {
      const { bob, aliceServiceWorkerStorageId, aliceServiceWorker, alice } =
        await setup()

      // bob subscribes to alice's service worker's storageId
      bob.subscribeToRemotes([aliceServiceWorkerStorageId])

      // alice creates a doc
      const aliceDoc = alice.create<TestDoc>()
      aliceDoc.change(d => (d.foo = "bar"))

      await pause(50)

      // bob waits for the document to arrive
      const bobDoc = await bob.find<TestDoc>(aliceDoc.url)

      // alice's service worker waits for the document to arrive
      const aliceServiceWorkerDoc = await aliceServiceWorker.find(
        aliceDoc.documentId
      )

      let aliceSeenByBobPromise = new Promise<DocHandleRemoteHeadsPayload>(
        resolve => {
          bobDoc.on("remote-heads", message => {
            if (message.storageId === aliceServiceWorkerStorageId) {
              resolve(message)
            }
          })
        }
      )

      // bob makes a change
      bobDoc.change(d => (d.foo = "baz"))

      // wait for alice's service worker to acknowledge the change
      const { heads } = await aliceSeenByBobPromise

      assert.deepStrictEqual(heads, aliceServiceWorkerDoc.heads())
    })

    it("should report remoteHeads only for documents the subscriber has open", async () => {
      const { alice, bob, bobServiceWorkerStorageId } = await setup()

      // alice subscribes to bob's service worker
      alice.subscribeToRemotes([bobServiceWorkerStorageId])

      // bob creates two docs
      const bobDocA = bob.create<TestDoc>()
      bobDocA.change(d => (d.foo = "A"))

      const bobDocB = bob.create<TestDoc>()
      bobDocB.change(d => (d.foo = "B"))

      await pause(50)

      // alice opens doc A
      const aliceDocAPromise = alice.find<TestDoc>(bobDocA.url)

      const remoteHeadsChangedMessages = (
        await collectMessages({
          emitter: alice.networkSubsystem,
          event: "message",
          until: aliceDocAPromise,
        })
      ).filter(({ type }) => type === "remote-heads-changed")

      const aliceDocA = await aliceDocAPromise

      // we should only be notified of the head changes of doc A
      assert(
        remoteHeadsChangedMessages.every(
          d => d.documentId === aliceDocA.documentId
        )
      )
    })

    it("should report remote heads for doc on subscribe if peer already knows them", async () => {
      const { alice, alice2, bob, bobServiceWorkerStorageId } = await setup()

      // bob creates 2 docs
      const bobDocA = bob.create<TestDoc>()
      bobDocA.change(d => (d.foo = "A"))

      const bobDocB = bob.create<TestDoc>()
      bobDocB.change(d => (d.foo = "B"))

      await pause(50)

      // alice opens the docs
      const _aliceDocA = alice.find<TestDoc>(bobDocA.url)
      const _aliceDocB = alice.find<TestDoc>(bobDocB.url)

      // alice subscribes to bob's service worker
      alice.subscribeToRemotes([bobServiceWorkerStorageId])

      // Now alice's service worker has the remote heads of bob's service worker for both doc A and
      // doc B. If alice subscribes to bob's service worker, bob's service worker should send its
      // stored remote heads immediately.

      // open doc and subscribe alice's second tab to bob's service worker
      const alice2DocAPromise = alice2.find<TestDoc>(bobDocA.url)
      alice2.subscribeToRemotes([bobServiceWorkerStorageId])

      const remoteHeadsChangedMessages = (
        await collectMessages({
          emitter: alice2.networkSubsystem,
          event: "message",
          until: alice2DocAPromise,
        })
      ).filter(({ type }) => type === "remote-heads-changed")

      const alice2DocA = await alice2DocAPromise

      // we should only be notified of the head changes of doc A
      assert.strictEqual(remoteHeadsChangedMessages.length, 1)
      assert(
        remoteHeadsChangedMessages.every(
          d => d.documentId === alice2DocA.documentId
        )
      )
    })

    it("should report remote heads for subscribed storage id once we open a new doc", async () => {
      const { alice, bob, bobServiceWorkerStorageId } = await setup()

      // bob creates 2 docs
      const bobDocA = bob.create<TestDoc>()
      bobDocA.change(d => (d.foo = "A"))

      const bobDocB = bob.create<TestDoc>()
      bobDocB.change(d => (d.foo = "B"))

      // alice subscribes to bob's service worker
      alice.subscribeToRemotes([bobServiceWorkerStorageId])

      await pause(50)

      // alice opens doc A
      const alice1DocAPromise = alice.find<TestDoc>(bobDocA.url)

      const remoteHeadsChangedMessages = (
        await collectMessages({
          emitter: alice.networkSubsystem,
          event: "message",
          until: alice1DocAPromise,
        })
      ).filter(({ type }) => type === "remote-heads-changed")

      const alice1DocA = await alice1DocAPromise

      assert.strictEqual(remoteHeadsChangedMessages.length, 1)
      assert(
        remoteHeadsChangedMessages.every(
          d => d.documentId === alice1DocA.documentId
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
    a.networkSubsystem.whenReady(),
    a.networkSubsystem.whenReady(),
  ])
}
