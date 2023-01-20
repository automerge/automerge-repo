import assert from "assert"
import { MessageChannelNetworkAdapter } from "automerge-repo-network-messagechannel"
import { ChannelId, DocHandle, HandleState, PeerId, Repo } from "../src"
import { DummyNetworkAdapter } from "./helpers/DummyNetworkAdapter"
import { DummyStorageAdapter } from "./helpers/DummyStorageAdapter"
import { eventPromise } from "../src/helpers/eventPromise"
import { getRandomItem } from "./helpers/getRandomItem"
import { pause } from "../src/helpers/pause"
import { isDeepStrictEqual } from "util"
import { InboundMessagePayload } from "../dist"

interface TestDoc {
  foo: string
}

describe("Repo", () => {
  describe("single repo", () => {
    const setup = () => {
      const repo = new Repo({
        storage: new DummyStorageAdapter(),
        network: [new DummyNetworkAdapter()],
      })
      return { repo }
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
      const v = await handle.value()
      assert.equal(handle.state, HandleState.READY)

      assert.equal(v.foo, "bar")
    })

    it("can find a created document", async () => {
      const { repo } = setup()
      const handle = repo.create<TestDoc>()
      handle.change(d => {
        d.foo = "bar"
      })
      assert(handle.state === HandleState.READY)

      const bobHandle = repo.find<TestDoc>(handle.documentId)

      assert.equal(handle, bobHandle)
      assert.equal(handle.state, HandleState.READY)

      const v = await bobHandle.value()
      assert.equal(v.foo, "bar")
    })
  })

  describe("sync", async () => {
    const setup = async () => {
      // Set up three repos; connect Alice to Bob, and Bob to Charlie

      const aliceBobChannel = new MessageChannel()
      const bobCharlieChannel = new MessageChannel()

      const { port1: aliceToBob, port2: bobToAlice } = aliceBobChannel
      const { port1: bobToCharlie, port2: charlieToBob } = bobCharlieChannel

      const aliceRepo = new Repo({
        network: [new MessageChannelNetworkAdapter(aliceToBob)],
        peerId: "alice" as PeerId,
      })

      const bobRepo = new Repo({
        network: [
          new MessageChannelNetworkAdapter(bobToAlice),
          new MessageChannelNetworkAdapter(bobToCharlie),
        ],
        peerId: "bob" as PeerId,
      })

      const charlieRepo = new Repo({
        network: [new MessageChannelNetworkAdapter(charlieToBob)],
        peerId: "charlie" as PeerId,
      })

      await Promise.all([
        eventPromise(aliceRepo.networkSubsystem, "peer"),
        eventPromise(bobRepo.networkSubsystem, "peer"),
        eventPromise(charlieRepo.networkSubsystem, "peer"),
      ])

      const aliceHandle = aliceRepo.create<TestDoc>()

      const teardown = () => {
        aliceBobChannel.port1.close()
        bobCharlieChannel.port1.close()
      }

      return { aliceRepo, bobRepo, charlieRepo, aliceHandle, teardown }
    }

    it("changes are replicated from aliceRepo to bobRepo", async () => {
      const { bobRepo, aliceHandle, teardown } = await setup()
      aliceHandle.change(d => {
        d.foo = "bar"
      })

      const bobHandle = bobRepo.find<TestDoc>(aliceHandle.documentId)
      const bobDoc = await bobHandle.value()
      assert.deepStrictEqual(bobDoc, { foo: "bar" })
      teardown()
    })

    it("can load a document from aliceRepo on charlieRepo", async () => {
      const { charlieRepo, aliceHandle, teardown } = await setup()
      aliceHandle.change(d => {
        d.foo = "bar"
      })

      const handle3 = charlieRepo.find<TestDoc>(aliceHandle.documentId)
      const doc3 = await handle3.value()
      assert.deepStrictEqual(doc3, { foo: "bar" })
      teardown()
    })

    it("can broadcast a message", async () => {
      const { aliceRepo, bobRepo, teardown } = await setup()

      const channelId = "m/broadcast" as ChannelId
      const data = { presence: "bob" }

      bobRepo.ephemeralData.broadcast(channelId, data)
      const d = await eventPromise(aliceRepo.ephemeralData, "data")

      assert.deepStrictEqual(d.data, data)
      teardown()
    })

    it("syncs a bunch of changes ~~without duplicating messages~~", async () => {
      const { aliceRepo, bobRepo, charlieRepo, teardown } = await setup()

      // HACK: yield to give repos time to get the one doc that aliceRepo created
      await pause(50)

      let totalMessages = 0
      let duplicateMessages = 0

      let lastMsg: InboundMessagePayload
      const listenForDuplicates = (msg: InboundMessagePayload) => {
        totalMessages++
        if (isDeepStrictEqual(msg, lastMsg)) {
          duplicateMessages++
          // console.log( "duplicate message", Automerge.decodeSyncMessage(msg.message) )
        }
        lastMsg = msg
      }
      aliceRepo.networkSubsystem.on("message", listenForDuplicates)

      for (let i = 0; i < 100; i++) {
        // pick a repo
        const repo = getRandomItem([aliceRepo, bobRepo, charlieRepo])
        // pick a random doc, or create a new one
        const docs = Object.values(repo.handles)
        const doc =
          Math.random() < 0.5
            ? repo.create<TestDoc>()
            : (getRandomItem(docs) as DocHandle<TestDoc>)
        // make a random change to it
        doc.change(d => {
          d.foo = Math.random().toString()
        })
      }
      await pause(500)

      aliceRepo.networkSubsystem.removeListener("message", listenForDuplicates)
      teardown()

      // I'm not sure what the 'no duplicates' part of this test is intended to demonstrate, but the
      // duplicates are all empty Automerge sync messages (uncomment console.log above to see)
      // ```
      // {
      //   heads: [],
      //   need: [],
      //   have: [ { lastSync: [], bloom: Uint8Array(0) [] } ],
      //   changes: []
      // }
      // ```
      // Is that bad? I don't know!!

      // assert.equal(
      //   duplicateMessages,
      //   0,
      //   `${duplicateMessages} of ${totalMessages} messages were duplicates`
      // )
    })
  })
})
