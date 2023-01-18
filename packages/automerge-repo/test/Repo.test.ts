import assert from "assert"
import { MessageChannelNetworkAdapter } from "automerge-repo-network-messagechannel"
import { ChannelId, DocHandle, HandleState, PeerId, Repo } from "../src"
import { DummyNetworkAdapter } from "./helpers/DummyNetworkAdapter"
import { DummyStorageAdapter } from "./helpers/DummyStorageAdapter"
import { eventPromise } from "../src/helpers/eventPromise"
import { getRandomItem } from "./helpers/getRandomItem"

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
      assert(repo !== null)
      assert(repo.networkSubsystem)
      assert(repo.storageSubsystem)
    })

    it("can create a document", () => {
      const { repo } = setup()
      const handle = repo.create()
      assert(handle.documentId != null)
    })

    it("can change a document", async () => {
      const { repo } = setup()
      const handle = repo.create<TestDoc>()
      handle.change(d => {
        d.foo = "bar"
      })
      assert(handle.state === HandleState.READY)

      const v = await handle.value()
      assert(v.foo === "bar")
    })

    it("can find a created document", async () => {
      const { repo } = setup()
      const handle = repo.create<TestDoc>()
      handle.change(d => {
        d.foo = "bar"
      })
      assert(handle.state === HandleState.READY)

      const bobHandle = repo.find<TestDoc>(handle.documentId)
      assert(handle === bobHandle)
      assert(bobHandle.ready())

      const v = await bobHandle.value()
      assert(v.foo === "bar")
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

      const aliceHandle = aliceRepo.create<TestDoc>()

      const teardown = () => {
        aliceBobChannel.port1.close()
        bobCharlieChannel.port1.close()
      }

      await Promise.all([
        eventPromise(aliceRepo.networkSubsystem, "peer"),
        eventPromise(bobRepo.networkSubsystem, "peer"),
        eventPromise(charlieRepo.networkSubsystem, "peer"),
      ])

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

    it.skip("can do some complicated sync thing without duplicating messages", async () => {
      const { aliceRepo, bobRepo, charlieRepo, teardown } = await setup()

      let lastMessage: any
      aliceRepo.networkSubsystem.on("message", msg => {
        // assert.notDeepStrictEqual(msg, lastMessage)
        lastMessage = msg
      })

      const CHANCE_OF_NEW_DOC = 0.05
      const repos = [aliceRepo, bobRepo, charlieRepo]

      for (let i = 0; i < 10; i++) {
        const repoIndex = Math.floor(Math.random() * repos.length)
        // pick a repo
        const repo = repos[repoIndex]
        const makeNewDoc = Math.random() < CHANCE_OF_NEW_DOC
        const doc = makeNewDoc
          ? repo.create<TestDoc>()
          : (getRandomItem(repo.handles) as DocHandle<TestDoc>)

        const docId = doc?.documentId ?? "no doc"
        console.log(
          `${i} | ${
            makeNewDoc ? "new" : "existing"
          } | repo ${repoIndex} | ${docId}`
        )
        doc.change(d => {
          d.foo = Math.random().toString()
        })
      }

      repos.forEach((r, i) => {
        console.log(`Repo ${i}: ${Object.keys(r.handles).length} documents.`)
      })
      teardown()
    })
  })
})
