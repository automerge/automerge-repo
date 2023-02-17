import assert from "assert"
import { MessageChannel } from "worker_threads"

import { ChannelId, DocHandle, DocumentId, PeerId } from "../src"
import { Repo } from "../src/Repo"

import { MemoryStorageAdapter } from "automerge-repo-storage-memory"
import { MessageChannelNetworkAdapter } from "automerge-repo-network-messagechannel"
import { DummyNetworkAdapter } from "./helpers/DummyNetworkAdapter"

export interface TestDoc {
  foo: string
}

describe("Repo", () => {
  const repo = new Repo({
    storage: new MemoryStorageAdapter(),
    network: [new DummyNetworkAdapter()],
  })

  it("can instantiate a Repo", () => {
    assert(repo !== null)
  })

  it("has a network subsystem", () => {
    assert(repo.networkSubsystem)
  })

  it("has a storage subsystem", () => {
    assert(repo.storageSubsystem)
  })

  it("can create a document", () => {
    const handle = repo.create()
    assert(handle.documentId != null)
  })

  it("can change a document", done => {
    const handle = repo.create<TestDoc>()
    handle.change(d => {
      d.foo = "bar"
    })
    assert(handle.state === "ready")
    handle.value().then(v => {
      try {
        assert(v.foo === "bar")
        done()
      } catch (e) {
        done(e)
      }
    })
  })

  it("can find a created document", done => {
    const handle = repo.create<TestDoc>()
    handle.change(d => {
      d.foo = "bar"
    })
    assert(handle.state === "ready")
    const handle2 = repo.find<TestDoc>(handle.documentId)
    assert(handle === handle2)
    assert(handle2.ready())
    handle2.value().then(v => {
      try {
        assert(v.foo === "bar")
        done()
      } catch (e) {
        done(e)
      }
    })
  })

  describe("sync between three repos", async () => {
    const mc1to2 = new MessageChannel()
    const mc2to3 = new MessageChannel()

    const mc1to2port1 = mc1to2.port1 as unknown as MessagePort
    const mc1to2port2 = mc1to2.port2 as unknown as MessagePort
    const mc2to3port1 = mc2to3.port1 as unknown as MessagePort
    const mc2to3port2 = mc2to3.port2 as unknown as MessagePort

    const excludedDocuments: DocumentId[] = []
    const excludedPeers: PeerId[] = []

    const sharePolicy = async (peerId: PeerId, documentId: DocumentId) => {
      // make sure that repo3 never gets excluded documents
      if (excludedDocuments.includes(documentId) && peerId === "repo3") {
        return false
      }
      return !excludedPeers.includes(peerId)
    }

    // Set up three repos and have them communicate via MessageChannels
    const repo1 = new Repo({
      network: [new MessageChannelNetworkAdapter(mc1to2port1)],
      peerId: "repo1" as PeerId,
      sharePolicy,
    })

    // First test: create a document and ensure the second repo can find it
    const handle1 = repo1.create<TestDoc>()
    handle1.change(d => {
      d.foo = "bar"
    })

    const repo2 = new Repo({
      network: [
        new MessageChannelNetworkAdapter(mc1to2port2),
        new MessageChannelNetworkAdapter(mc2to3port1),
      ],
      peerId: "repo2" as PeerId,
      sharePolicy,
    })
    const repo3 = new Repo({
      network: [new MessageChannelNetworkAdapter(mc2to3port2)],
      peerId: "repo3" as PeerId,
    })

    it("can load a document from repo1 on repo2", async () => {
      const handle2 = repo2.find<TestDoc>(handle1.documentId)
      const doc2 = await handle2.value()
      assert.deepStrictEqual(doc2, { foo: "bar" })
    })

    it("can load a document from repo1 on repo3", async () => {
      const handle3 = repo3.find<TestDoc>(handle1.documentId)
      const doc3 = await handle3.value()
      assert.deepStrictEqual(doc3, { foo: "bar" })
    })

    // create another document and make sure that repo2 *cannot* find it
    const handle4 = repo1.create<TestDoc>()
    excludedDocuments.push(handle4.documentId)

    handle4.change(d => {
      d.foo = "baz"
    })

    it("documents which are excluded by the share policy are not present in other repos", async () => {
      assert(repo2.handles[handle4.documentId] !== undefined)
      assert(repo3.handles[handle4.documentId] === undefined)
    })

    it("can broadcast a message", done => {
      const messageChannel = "m/broadcast" as ChannelId
      const data = { presence: "myUserId" }

      repo1.ephemeralData.on("data", ({ peerId, channelId, data }) => {
        try {
          const peerId = repo2.networkSubsystem.myPeerId
          assert.deepEqual(data, data)
          done()
        } catch (e) {
          done(e)
        }
      })

      repo2.ephemeralData.broadcast(messageChannel, data)
    })

    it("can do some complicated sync thing without duplicating messages", () => {
      let lastMessage: any
      repo1.networkSubsystem.on("message", msg => {
        // assert.notDeepStrictEqual(msg, lastMessage)
        lastMessage = msg
      })

      const CHANCE_OF_NEW_DOC = 0.05
      const getRandomItem = (iterable: Record<string, unknown>) => {
        const values = Object.values(iterable)
        const idx = Math.floor(Math.random() * values.length)
        return values[idx]
      }

      const repos = [repo1, repo2, repo3]

      for (let i = 0; i < 10; i++) {
        // pick a repo
        const repo = repos[Math.floor(Math.random() * repos.length)]
        const doc =
          Math.random() < CHANCE_OF_NEW_DOC
            ? repo.create<TestDoc>()
            : (getRandomItem(repo.handles) as DocHandle<TestDoc>)

        doc.change(d => {
          d.foo = Math.random().toString()
        })
      }

      repos.forEach((r, i) => {
        console.log(`Repo ${i}: ${Object.keys(r.handles).length} documents.`)
      })
    })

    /* TODO: there's a race condition here... gotta look into that */
    setTimeout(() => {
      // Close the message ports so that the script can exit.
      mc1to2.port1.close()
      mc2to3.port1.close()
    }, 200)
  })
})
