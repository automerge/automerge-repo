import { beelay, next as A } from "@automerge/automerge"
import { Repo } from "../src/Repo.js"
import { DummyStorageAdapter } from "../src/helpers/DummyStorageAdapter.js"
import { afterEach, describe, expect, it } from "vitest"
import { MessageChannelNetworkAdapter } from "../../automerge-repo-network-messagechannel/src/index.js"

describe("the Beelay integration", () => {
  let repos: Repo[] = []

  function makeRepo(): Repo {
    const repo = new Repo({
      network: [],
      storage: new DummyStorageAdapter(),
    })
    repos.push(repo)
    return repo
  }

  afterEach(() => {
    for (const repo of repos) {
      repo.shutdown()
    }
    repos = []
  })

  it("should synchronise a newly created doc to other beelay peers", async () => {
    const bob = makeRepo()
    const doc = await bob.create({ foo: "bar" })
    const alice = makeRepo()
    await connectAndSync(bob, alice)

    const docOnAlice = await alice.find(doc.documentId)
    expect(docOnAlice.doc()).to.deep.equal({ foo: "bar" })
  })

  it("should synchronise a document from another beelay peer", async () => {
    const bob = makeRepo()
    const doc = await bob.create({ foo: "bar" })
    const alice = makeRepo()
    await connectAndSync(alice, bob)

    const docOnAlice = await alice.find(doc.documentId)
    expect(docOnAlice.doc()).to.deep.equal({ foo: "bar" })
  })

  it("should synchronise a document created after connection", async () => {
    const bob = makeRepo()
    const alice = makeRepo()
    await connectAndSync(bob, alice)

    const doc = await bob.create({ foo: "bar" })

    await pause(200)

    const docOnAlice = await alice.find(doc.documentId)
    expect(docOnAlice.doc()).to.deep.equal({ foo: "bar" })
  })

  it("should synchronise changes made to a document", async () => {
    const bob = makeRepo()
    const alice = makeRepo()
    await connectAndSync(bob, alice)

    const doc = await bob.create({ foo: "bar" })

    await pause(100)

    const docOnAlice = await alice.find<{ foo: string }>(doc.documentId)
    expect(docOnAlice.doc()).to.deep.equal({ foo: "bar" })

    doc.change(d => (d.foo = "baz"))

    await pause(100)

    expect(docOnAlice.doc().foo).to.equal("baz")

    docOnAlice.change(d => (d.foo = "qux"))

    await pause(100)
    expect(docOnAlice.doc().foo).to.equal("qux")
  })
})

async function connectAndSync(left: Repo, right: Repo) {
  let { port1: leftToRight, port2: rightToLeft } = new MessageChannel()
  leftToRight.start()
  rightToLeft.start()

  function connectStream(stream: beelay.Stream, port: MessagePort) {
    stream.on("message", message => {
      port.postMessage(message)
    })
    port.onmessage = event => {
      stream.recv(new Uint8Array(event.data))
    }
    stream.on("disconnect", () => {
      port.close()
    })
  }

  let leftBeelay = await left.beelay()
  let rightBeelay = await right.beelay()

  let leftStream = leftBeelay.createStream({
    direction: "connecting",
    remoteAudience: {
      type: "peerId",
      peerId: rightBeelay.peerId,
    },
  })
  connectStream(leftStream, leftToRight)

  let rightStream = rightBeelay.createStream({
    direction: "accepting",
  })
  connectStream(rightStream, rightToLeft)

  await leftBeelay.waitUntilSynced(rightBeelay.peerId)
}

async function synced(from: Repo, to: Repo) {
  const fromBeelay = await from.beelay()
  const toBeelay = await to.beelay()
  await fromBeelay.waitUntilSynced(toBeelay.peerId)
}

async function connectLegacy(left: Repo, right: Repo) {
  const { port1: ab, port2: ba } = new MessageChannel()
  const leftAdapter = new MessageChannelNetworkAdapter(ab)
  const rightAdapter = new MessageChannelNetworkAdapter(ba)
  left.networkSubsystem.addNetworkAdapter(leftAdapter)
  right.networkSubsystem.addNetworkAdapter(rightAdapter)
}

async function pause(milliseconds: number) {
  await new Promise(resolve => setTimeout(resolve, milliseconds))
}
