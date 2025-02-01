import { MessageChannelNetworkAdapter } from "@automerge/automerge-repo-network-messagechannel"
import * as Automerge from "@automerge/automerge/next"
import assert from "assert"
import { eventPromise } from "../src/helpers/eventPromise.js"
import { pause } from "../src/helpers/pause.js"
import {
  DocHandle,
  DocumentId,
  PeerId,
  Repo,
  SharePolicy,
} from "../src/index.js"
import { getRandomItem } from "../test/helpers/getRandomItem.js"

interface TestDoc {
  [key: string]: any
}

const setup = async () => {
  // Set up three repos; connect Alice to Bob, and Bob to Charlie

  const aliceBobChannel = new MessageChannel()
  const bobCharlieChannel = new MessageChannel()

  const { port1: aliceToBob, port2: bobToAlice } = aliceBobChannel
  const { port1: bobToCharlie, port2: charlieToBob } = bobCharlieChannel

  const excludedDocuments: DocumentId[] = []

  const sharePolicy: SharePolicy = async (peerId, documentId) => {
    if (documentId === undefined) return false

    // make sure that charlie never gets excluded documents
    if (excludedDocuments.includes(documentId) && peerId === "charlie")
      return false

    return true
  }

  const aliceRepo = new Repo({
    network: [new MessageChannelNetworkAdapter(aliceToBob)],
    peerId: "A" as PeerId,
    sharePolicy,
  })

  const bobRepo = new Repo({
    network: [
      new MessageChannelNetworkAdapter(bobToAlice),
      new MessageChannelNetworkAdapter(bobToCharlie),
    ],
    peerId: "B" as PeerId,
    sharePolicy,
  })

  const charlieRepo = new Repo({
    network: [new MessageChannelNetworkAdapter(charlieToBob)],
    peerId: "C" as PeerId,
  })

  const aliceHandle = aliceRepo.create<TestDoc>()
  aliceHandle.change(d => {
    d.foo = "bar"
  })

  const notForCharlieHandle = aliceRepo.create<TestDoc>()
  const notForCharlie = notForCharlieHandle.documentId
  excludedDocuments.push(notForCharlie)
  notForCharlieHandle.change(d => {
    d.foo = "baz"
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
    teardown,
  }
}

const { aliceRepo, bobRepo, charlieRepo, teardown } = await setup()

// HACK: yield to give repos time to get the one doc that aliceRepo created
await pause(50)

for (let i = 0; i < 100000; i++) {
  // pick a repo
  const repo = getRandomItem([aliceRepo, bobRepo, charlieRepo])
  const docs = Object.values(repo.handles)
  const doc = getRandomItem(docs) as DocHandle<TestDoc>

  doc.change(d => {
    d.timestamp = Date.now()
    d.foo = { bar: Math.random().toString() }
  })

  await pause(0)
  const a = (await aliceRepo.find(doc.url)).doc()
  const b = (await bobRepo.find(doc.url)).doc()
  const c = (await charlieRepo.find(doc.url)).doc()
  assert.deepStrictEqual(a, b, "A and B should be equal")
  assert.deepStrictEqual(b, c, "B and C should be equal")

  const bin = Automerge.save(b)
  const load = Automerge.load(bin)
  assert.deepStrictEqual(b, load)

  console.log(
    "Changes:",
    Automerge.getAllChanges(a).length,
    Automerge.getAllChanges(b).length,
    Automerge.getAllChanges(c).length
  )
}

console.log("DONE")
await pause(500)

teardown()
