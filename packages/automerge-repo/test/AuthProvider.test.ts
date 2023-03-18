import assert from "assert"
import { MessageChannelNetworkAdapter } from "automerge-repo-network-messagechannel"

import {
  AuthenticateFn,
  authenticationError,
  AuthenticationResult,
  AUTHENTICATION_VALID,
} from "../src/auth/AuthProvider.js"
import { GenerousAuthProvider } from "../src/auth/GenerousAuthProvider.js"
import { eventPromise } from "../src/helpers/eventPromise.js"
import { pause } from "../src/helpers/pause.js"
import {
  AuthProvider,
  DocumentId,
  PeerId,
  Repo,
  SharePolicy,
} from "../src/index.js"
import { DummyAuthProvider } from "./helpers/DummyAuthProvider.js"
import { expectPromises } from "./helpers/expectPromises.js"
import type { TestDoc } from "./types"

const { encode } = new TextEncoder()
const { decode } = new TextDecoder()

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

    describe("without network communication", () => {
      it("a maximally restrictive  auth provider won't authenticate anyone", async () => {
        class RestrictiveAuthProvider extends GenerousAuthProvider {
          authenticate = async () => {
            return {
              isValid: false,
              error: new Error("nope"),
            }
          }
        }

        const restrictive = new RestrictiveAuthProvider()
        const { bobRepo, aliceHandle, teardown } = await setup(restrictive)

        await pause(50)
        // bob doesn't have alice's document
        assert.equal(bobRepo.handles[aliceHandle.documentId], undefined)

        teardown()
      })

      it("a maximally permissive auth provider authenticates everyone", async () => {
        class PermissiveAuthProvider extends GenerousAuthProvider {
          authenticate = async () => AUTHENTICATION_VALID
        }

        const permissive = new PermissiveAuthProvider()
        const { bobRepo, aliceHandle, teardown } = await setup(permissive)

        await pause(50)
        // bob has alice's document
        assert.notEqual(bobRepo.handles[aliceHandle.documentId], undefined)

        teardown()
      })

      it("a custom auth provider might just authenticate based on peerId", async () => {
        // TODO
      })
    })

    describe("with network communication", () => {
      // We'll make a (very insecure) password auth provider that sends
      // a password challenge, and compares the password returned to a
      // hard-coded password list.

      const CHALLENGE = "what is the password?"

      const PASSWORDS_TOP_SECRET: Record<string, string> = {
        alice: "abracadabra",
        bob: "bucaramanga",
      }

      // The auth provider is initialized with a password response, which
      // it will provide when challenged.
      class DummyPasswordAuthProvider extends GenerousAuthProvider {
        constructor(private passwordResponse: string) {
          super()
        }

        authenticate: AuthenticateFn = async (peerId, channel) => {
          return new Promise<AuthenticationResult>(resolve => {
            // send challenge
            channel.send(new TextEncoder().encode(CHALLENGE))

            channel.on("message", msg => {
              const msgText = new TextDecoder().decode(msg)
              switch (msgText) {
                case CHALLENGE:
                  // received challenge, send password
                  channel.send(new TextEncoder().encode(this.passwordResponse))
                  break
                case PASSWORDS_TOP_SECRET[peerId]:
                  // received correct password
                  resolve(AUTHENTICATION_VALID)
                  break
                default:
                  // received incorrect password
                  resolve(authenticationError("that is not the password"))
                  break
              }
            })
          })
        }
      }

      it("should sync with bob if he provides the right password", async () => {
        const { aliceRepo, bobRepo, aliceHandle, teardown } = await setup({
          alice: new DummyPasswordAuthProvider("abracadabra"), // ✅ alice gives the correct password
          bob: new DummyPasswordAuthProvider("bucaramanga"), // ✅ bob gives the correct password
        })

        // if these resolve, we've been authenticated
        await expectPromises(
          eventPromise(aliceRepo.networkSubsystem, "peer"), // ✅
          eventPromise(bobRepo.networkSubsystem, "peer") // ✅
        )

        // bob should now receive alice's document
        const bobHandle = bobRepo.find<TestDoc>(aliceHandle.documentId)
        await eventPromise(bobHandle, "change")
        const doc = await bobHandle.value()
        assert.equal(doc.foo, "bar")

        teardown()
      })

      it("shouldn't sync with bob if he provides the wrong password", async () => {
        const { aliceRepo, bobRepo, aliceHandle, teardown } = await setup({
          alice: new DummyPasswordAuthProvider("abracadabra"), // ✅ alice gives the correct password
          bob: new DummyPasswordAuthProvider("asdfasdfasdf"), // ❌ bob gives the wrong password
        })

        await expectPromises(
          eventPromise(aliceRepo.networkSubsystem, "error"), // ❌ alice doesn't authenticate bob, because his password was wrong
          eventPromise(bobRepo.networkSubsystem, "peer") // ✅ bob authenticates alice
        )

        // bob doesn't have alice's document
        const alicesDocumentForBob = bobRepo.handles[aliceHandle.documentId]
        assert.equal(
          alicesDocumentForBob,
          undefined,
          "bob doesn't have alice's document"
        )

        teardown()
      })
    })

    describe("adding encryption to the network adapter", () => {
      it("encrypts outgoing messages and decrypts incoming messages", () => {
        // class EncryptingAuthProvider extends GenerousAuthProvider {
        //   authenticate = async () => VALID
        // }
      })
    })
  })
})
