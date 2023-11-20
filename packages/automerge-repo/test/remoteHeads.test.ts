import * as A from "@automerge/automerge/next"
import assert from "assert"
import { decode } from "cbor-x"
import { describe, it } from "vitest"
import { generateAutomergeUrl, parseAutomergeUrl } from "../src/AutomergeUrl.js"
import { eventPromise } from "../src/helpers/eventPromise.js"
import { pause } from "../src/helpers/pause.js"
import {
  DocHandle,
  DocHandleRemoteHeadsPayload,
  PeerId,
  Repo,
} from "../src/index.js"
import { TestDoc } from "./types.js"
import { MessageChannelNetworkAdapter } from "@automerge/automerge-repo-network-messagechannel"
import { setTimeout } from "timers/promises"
import { DummyStorageAdapter } from "./helpers/DummyStorageAdapter.js"

describe("DocHandle.remoteHeads", () => {
  const TEST_ID = parseAutomergeUrl(generateAutomergeUrl()).documentId

  it("should allow to listen for remote head changes and manually read remote heads", async () => {
    const handle = new DocHandle<TestDoc>(TEST_ID, { isNew: true })
    const bobRepo = new Repo({
      peerId: "bob" as PeerId,
      network: [],
      storage: new DummyStorageAdapter(),
    })
    const bobStorageId = await bobRepo.storageSubsystem.id()

    const remoteHeadsMessagePromise = eventPromise(handle, "remote-heads")
    handle.setRemoteHeads(bobStorageId, [])

    const remoteHeadsMessage = await remoteHeadsMessagePromise

    assert.strictEqual(remoteHeadsMessage.storageId, bobStorageId)
    assert.deepStrictEqual(remoteHeadsMessage.heads, [])

    // read remote heads manually
    assert.deepStrictEqual(handle.getRemoteHeads(bobStorageId), [])
  })

  it("should report remoteHeads for peers who are several hops away", async () => {
    // replicates a tab -> service worker -> sync server <- service worker <- tab scenario
    const leftTab = new Repo({
      peerId: "left-tab" as PeerId,
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
    connectRepos(leftTab, leftServiceWorker)
    connectRepos(leftServiceWorker, syncServer)
    connectRepos(syncServer, rightServiceWorker)
    connectRepos(rightServiceWorker, rightTab)

    await setTimeout(100)

    // subscribe to the left service worker storage ID on the right tab
    rightTab.subscribeToRemotes([await leftServiceWorker.storageId()!])

    await setTimeout(100)

    // create a doc in the left tab
    const leftTabDoc = leftTab.create<TestDoc>()
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
