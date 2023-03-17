import assert from "assert"
import { MessageChannelNetworkAdapter } from "automerge-repo-network-messagechannel"

import { ChannelId, DocHandle, DocumentId, PeerId, Repo } from "../src"
import {
  AuthProvider,
  SharePolicy,
  AUTHENTICATION_VALID,
} from "../src/auth/AuthProvider"
import { eventPromise } from "../src/helpers/eventPromise"
import { pause } from "../src/helpers/pause"
import { DummyAuthProvider } from "./helpers/DummyAuthProvider"
import { DummyPasswordAuthProvider } from "./helpers/DummyPasswordAuthProvider"
import { expectPromises } from "./helpers/expectPromises"
import { getRandomItem } from "./helpers/getRandomItem"
import { TestDoc } from "./types"

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
      await pause(100)

      assert.notEqual(aliceRepo.handles[notForCharlie], undefined, "alice yes")
      assert.notEqual(bobRepo.handles[notForCharlie], undefined, "bob yes")
      assert.equal(charlieRepo.handles[notForCharlie], undefined, "charlie no")

      teardown()
    })
  })

  describe("authentication", () => {
    const setup = async (authProvider: AuthProvider) => {
      const aliceBobChannel = new MessageChannel()
      const { port1: aliceToBob, port2: bobToAlice } = aliceBobChannel

      const aliceRepo = new Repo({
        network: [new MessageChannelNetworkAdapter(aliceToBob)],
        peerId: "alice" as PeerId,
        authProvider,
      })

      const bobRepo = new Repo({
        network: [new MessageChannelNetworkAdapter(bobToAlice)],
        peerId: "bob" as PeerId,
        authProvider,
      })

      const aliceHandle = aliceRepo.create<TestDoc>()
      aliceHandle.change(d => {
        d.foo = "bar"
      })

      const teardown = () => {
        aliceBobChannel.port1.close()
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

    it("error message is emitted on the peer that denied connection", async () => {
      const aliceAuthProvider = new DummyAuthProvider({
        authenticate: async (peerId: PeerId) => {
          if (peerId == "alice") {
            return AUTHENTICATION_VALID
          } else {
            return {
              isValid: false,
              error: new Error("you are not Alice"),
            }
          }
        },
      })
      const { aliceRepo, bobRepo, teardown } = await setup(aliceAuthProvider)

      await expectPromises(
        eventPromise(aliceRepo.networkSubsystem, "error"), // I am bob's failed attempt to connect
        eventPromise(bobRepo.networkSubsystem, "peer")
      )

      teardown()
    })

    it("can communicate over the network to authenticate", async () => {
      const { aliceRepo, bobRepo, teardown } = await setup(
        new DummyPasswordAuthProvider("password")
      )

      await expectPromises(
        eventPromise(aliceRepo.networkSubsystem, "peer"),
        eventPromise(bobRepo.networkSubsystem, "peer")
      )

      teardown()
    })
  })
})
