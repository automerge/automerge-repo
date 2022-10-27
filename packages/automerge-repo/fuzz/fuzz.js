import { MessageChannel } from "worker_threads"
import { Repo } from "../dist/index.js"
import { MessageChannelNetworkAdapter } from "automerge-repo-network-messagechannel"
import * as assert from "assert"

const mc1to2 = new MessageChannel()
const mc2to3 = new MessageChannel()

// Set up three repos and have them communicate via MessageChannels
const repo1 = new Repo({
  network: [new MessageChannelNetworkAdapter(mc1to2.port1)],
  peerId: "repo1",
})
const repo2 = new Repo({
  network: [
    new MessageChannelNetworkAdapter(mc1to2.port2),
    new MessageChannelNetworkAdapter(mc2to3.port1),
  ],
  peerId: "repo2",
})
const repo3 = new Repo({
  network: [new MessageChannelNetworkAdapter(mc2to3.port2)],
  peerId: "repo3",
})

// First test: create a document and ensure the second repo can find it
const handle1 = repo1.create()
handle1.change((d) => {
  d.foo = "bar"
})

const handle2 = repo2.find(handle1.documentId)
const doc2 = await handle2.value()
assert.deepStrictEqual(doc2, { foo: "bar" })

// Make sure it can sync onwards to the third node
const handle3 = repo3.find(handle1.documentId)
const doc3 = await handle3.value()
assert.deepStrictEqual(doc3, { foo: "bar" })

let lastMessage = null
repo1.networkSubsystem.on("message", (msg) => {
  assert.notDeepStrictEqual(msg, lastMessage)
  console.log("messages were not equal")
})

const CHANCE_OF_NEW_DOC = 0.05
const getRandomItem = (iterable) => {
  const values = Object.values(iterable)
  const idx = Math.floor(Math.random() * values.length)
  return values[idx]
}

const repos = [repo1, repo2, repo3]

for (let i = 0; i < 100; i++) {
  // pick a repo
  const repo = repos[Math.floor(Math.random() * repos.length)]
  const doc =
    Math.random() < CHANCE_OF_NEW_DOC
      ? repo.create()
      : getRandomItem(repo.handles)

  doc.change((d) => {
    d.foo = Math.random().toString()
  })
}

console.log("*****************************")
repos.forEach((r, i) => {
  console.log(`Repo ${i}: ${Object.keys(r.handles).length} documents.`)
})
console.log("*****************************")

// Close the message ports so that the script can exit.
mc1to2.port1.close()
mc2to3.port1.close()
