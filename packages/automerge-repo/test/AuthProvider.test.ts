import assert from "assert"
import { MessageChannelNetworkAdapter } from "automerge-repo-network-messagechannel"

import type { DocumentId, PeerId, SharePolicy } from "../src/index.js"
import { AuthProvider, Repo } from "../src/index.js"
import { eventPromise } from "../src/helpers/eventPromise.js"
import { pause } from "../src/helpers/pause.js"
import { DummyAuthProvider } from "./helpers/DummyAuthProvider.js"
import { DummyPasswordAuthProvider } from "./helpers/DummyPasswordAuthProvider.js"
import { expectPromises } from "./helpers/expectPromises.js"
import type { TestDoc } from "./types"

describe("AuthProvider", () => {
  describe("authorization", async () => {
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

      const authProvider = new DummyAuthProvider({ sharePolicy })

      const aliceRepo = new Repo({
        network: [new MessageChannelNetworkAdapter(aliceToBob)],
        peerId: "alice" as PeerId,
        authProvider,
      })

      const bobRepo = new Repo({
        network: [
          new MessageChannelNetworkAdapter(bobToAlice),
          new MessageChannelNetworkAdapter(bobToCharlie),
        ],
        peerId: "bob" as PeerId,
        authProvider,
      })

      const charlieRepo = new Repo({
        network: [new MessageChannelNetworkAdapter(charlieToBob)],
        peerId: "charlie" as PeerId,
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

    it("charlieRepo doesn't have a document it's not supposed to have", async () => {
      const { aliceRepo, bobRepo, charlieRepo, notForCharlie, teardown } =
        await setup()

      // HACK: we don't know how long to wait before confirming the handle would have been advertised but wasn't
      await pause(50)

      assert.notEqual(aliceRepo.handles[notForCharlie], undefined, "alice yes")
      assert.notEqual(bobRepo.handles[notForCharlie], undefined, "bob yes")
      assert.equal(charlieRepo.handles[notForCharlie], undefined, "charlie no")

      teardown()
    })
  })

  describe("authentication", () => {
    const setup = async (
      authProvider: AuthProvider | Record<string, AuthProvider>
    ) => {
      if (authProvider instanceof AuthProvider)
        authProvider = {
          alice: authProvider,
          bob: authProvider,
        }

      const aliceBobChannel = new MessageChannel()
      const { port1: aliceToBob, port2: bobToAlice } = aliceBobChannel

      const aliceRepo = new Repo({
        network: [new MessageChannelNetworkAdapter(aliceToBob)],
        peerId: "alice" as PeerId,
        authProvider: authProvider.alice,
      })

      const bobRepo = new Repo({
        network: [new MessageChannelNetworkAdapter(bobToAlice)],
        peerId: "bob" as PeerId,
        authProvider: authProvider.bob,
      })

      const aliceHandle = aliceRepo.create<TestDoc>()
      aliceHandle.change(d => {
        d.foo = "bar"
      })

      const teardown = () => {
        aliceToBob.close()
        bobToAlice.close()
      }

      return {
        aliceRepo,
        bobRepo,
        aliceHandle,
        teardown,
      }
    }

    it("doesn't connect when authentication fails", async () => {
      const neverAuthProvider = new DummyAuthProvider({
        authenticate: async () => ({
          isValid: false,
          error: new Error("nope"),
        }),
      })
      const { aliceRepo, bobRepo, teardown } = await setup(neverAuthProvider)

      await expectPromises(
        eventPromise(aliceRepo.networkSubsystem, "error"),
        eventPromise(bobRepo.networkSubsystem, "error")
      )

      teardown()
    })

    it("can communicate over the network to authenticate", async () => {
      const { aliceRepo, bobRepo, aliceHandle, teardown } = await setup({
        alice: new DummyPasswordAuthProvider("abracadabra"), // ✅
        bob: new DummyPasswordAuthProvider("bucaramanga"), // ✅
      })

      // if these resolve, we've been authenticated
      await expectPromises(
        eventPromise(aliceRepo.networkSubsystem, "peer"),
        eventPromise(bobRepo.networkSubsystem, "peer")
      )

      // bob should now receive alice's document
      const bobHandle = bobRepo.find<TestDoc>(aliceHandle.documentId)
      await eventPromise(bobHandle, "change")
      const doc = await bobHandle.value()
      assert.equal(doc.foo, "bar")

      teardown()
    })

    it("emits an error when authentication fails", async () => {
      const { aliceRepo, bobRepo, aliceHandle, teardown } = await setup({
        alice: new DummyPasswordAuthProvider("abracadabra"), // ✅
        bob: new DummyPasswordAuthProvider("asdfasdfasdf"), // ❌ wrong password
      })

      await expectPromises(
        eventPromise(aliceRepo.networkSubsystem, "error"), // Bob's failed attempt
        eventPromise(bobRepo.networkSubsystem, "peer")
      )

      await pause(50)

      // bob doesn't have alice's document
      assert.equal(bobRepo.handles[aliceHandle.documentId], undefined)

      teardown()
    })
  })
})
