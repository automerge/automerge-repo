import { MessageChannelNetworkAdapter } from "../../automerge-repo-network-messagechannel/src/index.js"
import * as Automerge from "@automerge/automerge"
import assert from "assert"
import { eventPromise } from "../src/helpers/eventPromise.js"
import { headsAreSame } from "../src/helpers/headsAreSame.js"
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
    if (excludedDocuments.includes(documentId) && peerId === "C")
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

const { aliceRepo, bobRepo, charlieRepo, notForCharlie, teardown } = await setup()

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

  // Deterministic sync wait: subscribe to each peer's handle and resolve
  // only once its heads match the change we just made. Charlie is
  // excluded from `notForCharlie` by sharePolicy, so skip its wait there.
  const targetHeads = doc.heads()
  const otherRepos = [aliceRepo, bobRepo, charlieRepo].filter(r => r !== repo)
  await Promise.all(
    otherRepos.map(async r => {
      if (r === charlieRepo && doc.documentId === notForCharlie) return
      const h = await r.find<TestDoc>(doc.url)
      while (!headsAreSame(h.heads(), targetHeads)) {
        await eventPromise(h, "change")
      }
    })
  )

  const a = (await aliceRepo.find<TestDoc>(doc.url)).doc()
  const b = (await bobRepo.find<TestDoc>(doc.url)).doc()
  assert.deepStrictEqual(a, b, "A and B should be equal")
  let c: Automerge.Doc<TestDoc> | undefined
  if (doc.documentId !== notForCharlie) {
    c = (await charlieRepo.find<TestDoc>(doc.url)).doc()
    assert.deepStrictEqual(b, c, "B and C should be equal")
  }

  const bin = Automerge.save(b)
  const load = Automerge.load(bin)
  assert.deepStrictEqual(b, load)

  console.log(
    "Changes:",
    Automerge.getAllChanges(a).length,
    Automerge.getAllChanges(b).length,
    c ? Automerge.getAllChanges(c).length : "-"
  )
}

console.log("DONE")
await pause(500)

teardown()
