import assert from "assert"
import { MessageChannelNetworkAdapter } from "@automerge/automerge-repo-network-messagechannel"
import { describe, it } from "vitest"
import { authenticationError, AuthProvider } from "../src/auth/AuthProvider.js"
import { eventPromise } from "../src/helpers/eventPromise.js"
import { pause } from "../src/helpers/pause.js"
import { withTimeout } from "../src/helpers/withTimeout.js"
import {
  DocumentId,
  PeerId,
  Repo,
  RepoMessage,
  SharePolicy,
} from "../src/index.js"
import { decrypt, encrypt } from "./helpers/encrypt.js"
import { expectPromises } from "./helpers/expectPromises.js"
import type { TestDoc } from "./types.js"
import { AuthenticateFn, AuthenticationResult } from "../src/auth/types.js"
import { AUTHENTICATION_VALID } from "../src/auth/constants.js"

describe("AuthProvider", () => {
  describe("authorization", async () => {
    const setup = async () => {
      // Set up three repos; connect Alice to Bob, and Bob to Charlie

      const aliceBobChannel = new MessageChannel()
      const bobCharlieChannel = new MessageChannel()

      const { port1: aliceToBob, port2: bobToAlice } = aliceBobChannel
      const { port1: bobToCharlie, port2: charlieToBob } = bobCharlieChannel

      class NotForCharlieAuthProvider extends AuthProvider {
        excludedDocs: DocumentId[] = []

        // make sure that charlie never learns about excluded documents
        notForCharlie: SharePolicy = async (peerId, documentId) => {
          if (this.excludedDocs.includes(documentId!) && peerId === "charlie")
            return false
          return true
        }

        okToAdvertise = this.notForCharlie
        okToSync = this.notForCharlie
      }

      const authProvider = new NotForCharlieAuthProvider()

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
      authProvider.excludedDocs.push(notForCharlie)

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

    it("charlie doesn't learn about a document he's not supposed to have", async () => {
      const { aliceRepo, bobRepo, charlieRepo, notForCharlie, teardown } =
        await setup()

      // HACK: we don't know how long to wait before confirming the handle would have been advertised but wasn't
      await pause(50)

      assert.notEqual(aliceRepo.handles[notForCharlie], undefined, "alice yes")
      assert.notEqual(bobRepo.handles[notForCharlie], undefined, "bob yes")
      assert.equal(charlieRepo.handles[notForCharlie], undefined, "charlie no")

      teardown()
    })

    it("charlie doesn't get a document he's not supposed to have even if he learns its id", async () => {
      const { aliceRepo, bobRepo, charlieRepo, notForCharlie, teardown } =
        await setup()

      const aliceHandle = aliceRepo.find(notForCharlie)
      const bobHandle = bobRepo.find(notForCharlie)
      const charlieHandle = charlieRepo.find(notForCharlie)

      await pause(50)

      assert.equal(aliceHandle.isReady(), true, "alice yes")
      assert.equal(bobHandle.isReady(), true, "bob yes")
      assert.equal(charlieHandle.isReady(), false, "charlie no")

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
      it("a maximally restrictive auth provider won't authenticate anyone", async () => {
        const restrictive = new AuthProvider({
          authenticate: async () => {
            return {
              isValid: false,
              error: new Error("nope"),
            }
          },
          okToAdvertise: async () => false,
          okToSync: async () => false,
        })
        const { bobRepo, aliceHandle, teardown } = await setup(restrictive)

        await pause(50)
        // bob doesn't have alice's document
        assert.equal(bobRepo.handles[aliceHandle.documentId], undefined)

        teardown()
      })

      it("a maximally permissive auth provider authenticates everyone", async () => {
        const permissive = new AuthProvider() // AuthProvider is maximally permissive by default
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
      // We'll make a (very insecure) password auth provider that sends a password challenge, and
      // compares the password returned to a hard-coded password list.
      class PasswordAuthProvider extends AuthProvider {
        // The auth provider is initialized with a password response, which it will provide when
        // challenged.
        constructor(private passwordResponse: string) {
          super()
        }

        #challenge = "what is the password?"

        #passwords: Record<string, string> = {
          alice: "abracadabra",
          bob: "bucaramanga",
        }

        authenticate: AuthenticateFn = async (peerId, channel) => {
          return new Promise<AuthenticationResult>((resolve, reject) => {
            // send challenge
            channel.send(new TextEncoder().encode(this.#challenge))

            channel.on("message", msg => {
              const msgText = new TextDecoder().decode(msg)
              switch (msgText) {
                case this.#challenge:
                  // received challenge, send password
                  channel.send(new TextEncoder().encode(this.passwordResponse))
                  break

                case this.#passwords[peerId]:
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
          alice: new PasswordAuthProvider("abracadabra"), // ✅ alice gives the correct password
          bob: new PasswordAuthProvider("bucaramanga"), // ✅ bob gives the correct password
        })

        // if these resolve, we've been authenticated
        await expectPromises(
          eventPromise(aliceRepo.networkSubsystem, "peer"), // ✅
          eventPromise(bobRepo.networkSubsystem, "peer") // ✅
        )

        // bob should now receive alice's document
        const bobHandle = bobRepo.find<TestDoc>(aliceHandle.documentId)
        await eventPromise(bobHandle, "change")
        const doc = await bobHandle.doc()
        assert.equal(doc.foo, "bar")

        teardown()
      })

      it("shouldn't sync with bob if he provides the wrong password", async () => {
        const { aliceRepo, bobRepo, aliceHandle, teardown } = await setup({
          alice: new PasswordAuthProvider("abracadabra"), // ✅ alice gives the correct password
          bob: new PasswordAuthProvider("asdfasdfasdf"), // ❌ bob gives the wrong password
        })

        await expectPromises(
          eventPromise(aliceRepo.networkSubsystem, "error"), // ❌ alice doesn't authenticate bob, because his password was wrong
          eventPromise(bobRepo.networkSubsystem, "peer") // ✅ bob authenticates alice
        )

        // bob doesn't have alice's document
        const alicesDocumentForBob = bobRepo.handles[aliceHandle.documentId]
        assert.equal(alicesDocumentForBob, undefined)

        teardown()
      })
    })

    describe("adding encryption to the network adapter", () => {
      // The idea here is that rather than authenticate peers, the auth provider
      // encrypts and decrypts messages using a secret key that each peer knows.
      // No keys are revealed, but the peers can only communicate if they know the
      // secret key.

      function encryptingAuthProvider(secretKey: string) {
        return new AuthProvider({
          transform: {
            inbound: (message: RepoMessage) => {
              if ("data" in message) {
                const decrypted = decrypt(message.data, secretKey)
                return { ...message, data: decrypted }
              }
            },
            outbound: (message: RepoMessage) => {
              if ("data" in message) {
                const encrypted = encrypt(message.data, secretKey)
                return { ...message, data: encrypted }
              }
            },
          },
        })
      }

      it("encrypts outgoing messages and decrypts incoming messages", async () => {
        const { aliceRepo, bobRepo, aliceHandle, teardown } = await setup({
          alice: encryptingAuthProvider("BatteryHorseCorrectStaple"),
          bob: encryptingAuthProvider("BatteryHorseCorrectStaple"),
        })

        await expectPromises(
          eventPromise(aliceRepo.networkSubsystem, "peer"), // ✅
          eventPromise(bobRepo.networkSubsystem, "peer") // ✅
        )

        // bob has alice's document
        const bobHandle = bobRepo.find<TestDoc>(aliceHandle.documentId)
        await eventPromise(bobHandle, "change")
        const doc = await bobHandle.doc()
        assert.equal(doc.foo, "bar")

        teardown()
      })

      it("doesn't sync if both peers don't use the same secret key", async () => {
        const { aliceRepo, bobRepo, aliceHandle, teardown } = await setup({
          alice: encryptingAuthProvider("BatteryHorseCorrectStaple"),
          bob: encryptingAuthProvider("asdfasdfasdfasdfadsf"),
        })

        // one of these will throw an error, the other will hang
        await withTimeout(
          Promise.race([
            eventPromise(aliceRepo.networkSubsystem, "error"),
            eventPromise(bobRepo.networkSubsystem, "error"),
          ]),
          50
        )

        // bob doesn't have alice's document
        assert.equal(bobRepo.handles[aliceHandle.documentId], undefined)

        teardown()
      })
    })
  })
})
