import { describe, expect, it } from "vitest"
import assert from "assert"
import twoPeers from "./helpers/twoPeers.js"
import connectRepos from "./helpers/connectRepos.js"
import awaitState from "./helpers/awaitState.js"
import withTimeout from "./helpers/withTimeout.js"
import pause from "./helpers/pause.js"
import { Repo } from "../src/Repo.js"
import { PeerId } from "../src/types.js"

describe("the sharePolicy APIs", () => {
  describe("the legacy API", () => {
    it("should announce documents to peers for whom the sharePolicy returns true", async () => {
      const { alice, bob } = await twoPeers({
        alice: { sharePolicy: async () => true },
        bob: { sharePolicy: async () => true },
      })
      const handle = alice.create({ foo: "bar" })

      // Wait for the announcement to be synced
      await pause(100)

      // Disconnect and stop alice
      await alice.shutdown()

      // Bob should have the handle already because it was announced to him
      const bobHandle = await bob.find(handle.url)
    })

    it("should not annouce documents to peers for whom the sharePolicy returns false", async () => {
      const { alice, bob } = await twoPeers({
        alice: { sharePolicy: async () => false },
        bob: { sharePolicy: async () => true },
      })
      const handle = alice.create({ foo: "bar" })

      // Disconnect and stop alice
      await alice.shutdown()

      // Bob should have the handle already because it was announced to him
      const bobHandle = await withTimeout(bob.find(handle.url), 100)
      assert.equal(bobHandle, null)
    })

    it("should respond to direct requests for document where the sharePolicy returns false", async () => {
      const { alice, bob } = await twoPeers({
        alice: { sharePolicy: async () => false },
        bob: { sharePolicy: async () => true },
      })

      const aliceHandle = alice.create({ foo: "bar" })
      const bobHandle = await bob.find(aliceHandle.url)
    })
  })

  it("should respond to direct requests for document where the announce policy returns false but the access policy returns true", async () => {
    const { alice, bob } = await twoPeers({
      alice: {
        shareConfig: {
          announce: async () => false,
          access: async () => true,
        },
      },
      bob: { sharePolicy: async () => true },
    })

    const aliceHandle = alice.create({ foo: "bar" })
    const bobHandle = await bob.find(aliceHandle.url)
  })

  it("should not respond to direct requests for a document where the access policy returns false and the announce policy return trrrue", async () => {
    const { alice, bob } = await twoPeers({
      alice: {
        shareConfig: {
          announce: async () => true,
          access: async () => false,
        },
      },
      bob: { sharePolicy: async () => true },
    })

    const aliceHandle = alice.create({ foo: "bar" })
    withTimeout(
      awaitState(bob.findWithProgress(aliceHandle.url), "unavailable"),
      500
    )
  })

  it("should not respond to direct requests for a document where the access policy and the announce policy return false", async () => {
    const { alice, bob } = await twoPeers({
      alice: {
        shareConfig: {
          announce: async () => false,
          access: async () => false,
        },
      },
      bob: { sharePolicy: async () => false },
    })

    const aliceHandle = alice.create({ foo: "bar" })
    withTimeout(
      awaitState(bob.findWithProgress(aliceHandle.url), "unavailable"),
      500
    )
  })

  describe("Repo.sharePolicyChanged", () => {
    it("should respond to requests for a dochandle which was denied by the sharepolicy but then allowed", async () => {
      const alicePolicy = { shouldShare: false }
      const { alice, bob } = await twoPeers({
        alice: {
          shareConfig: {
            announce: async () => false,
            access: async () => alicePolicy.shouldShare,
          },
        },
        bob: { sharePolicy: async () => true },
      })

      const aliceHandle = alice.create({ foo: "bar" })
      await withTimeout(
        awaitState(bob.findWithProgress(aliceHandle.url), "unavailable"),
        500
      )

      // Change policy to allow sharing
      alicePolicy.shouldShare = true
      alice.shareConfigChanged()

      // Give time for Alices syncDebounceRate to elapse to start syncing with Bob
      await pause(150)

      const bobHandle = await bob.find(aliceHandle.url)
      expect(bobHandle.doc()).toEqual({ foo: "bar" })
    })

    it("should stop sending changes to a peer who had access but was then removed", async () => {
      const alicePolicy = {
        shouldShareWithBob: true,
      }
      const alice = new Repo({
        peerId: "alice" as PeerId,
        shareConfig: {
          announce: async () => false,
          access: async peerId => {
            if (peerId === "bob") {
              return alicePolicy.shouldShareWithBob
            }
            return true
          },
        },
      })
      const bob = new Repo({
        peerId: "bob" as PeerId,
        shareConfig: {
          announce: async () => true,
          access: async () => true,
        },
      })
      const charlie = new Repo({
        peerId: "charlie" as PeerId,
        shareConfig: {
          announce: async () => true,
          access: async () => true,
        },
      })

      await connectRepos(alice, charlie)
      await connectRepos(alice, bob)

      // create a handle on alice, request it on bob and charlie
      const aliceHandle = alice.create({ foo: "bar" })
      const bobHandle = await bob.find<{ foo: string }>(aliceHandle.url)
      const charlieHandle = await charlie.find<{ foo: string }>(aliceHandle.url)

      // Now remove bobs access
      alicePolicy.shouldShareWithBob = false
      alice.shareConfigChanged()

      // Now make a change on charlie
      charlieHandle.change(d => (d.foo = "baz"))

      // Wait for sync to propagate
      await pause(300)

      assert.deepStrictEqual(bobHandle.doc(), { foo: "bar" })
    })

    it("should not announce changes to a peer who reconnects", async () => {
      // This test is exercising an issue where a peer who reconnects receives
      // notifications about changes to a document they requested in a
      // previous connection but have not requested since reconnection. This
      // occurs because in order to calculate whether a peer has access to a
      // document the Repo keeps track of whether the given peer has ever
      // requested that document. If this state is not cleared on reconnection
      // then repo will continue to announce changes to the peer in question.
      const { alice, bob } = await twoPeers({
        alice: {
          shareConfig: {
            announce: async () => false,
            access: async () => true,
          },
        },
        bob: { sharePolicy: async () => true },
      })

      const aliceHandle = alice.create({ foo: "bar" })
      const bobHandle = await bob.find(aliceHandle.url)
      assert(bobHandle != null)

      // Disconnect everyone
      bob.networkSubsystem.adapters[0].emit("peer-disconnected", {
        peerId: alice.peerId,
      })
      alice.networkSubsystem.adapters[0].emit("peer-disconnected", {
        peerId: bob.peerId,
      })
      bob.networkSubsystem.disconnect()
      alice.networkSubsystem.disconnect()

      await pause(150)

      // Create a new repo with the same peer ID and reconnect
      const bob2 = new Repo({ peerId: "bob" as PeerId })
      await connectRepos(alice, bob2)

      // Now create a third repo and connect it to alice
      const charlie = new Repo({ peerId: "charlie" as PeerId })
      await connectRepos(alice, charlie)

      // Make a change on charlie, this will send a message to alice
      // who will forward to anyone who she thinks has previously
      // requested the document
      const charlieHandle = await charlie.find<{ foo: string }>(aliceHandle.url)
      charlieHandle.change(d => (d.foo = "baz"))

      await pause(300)

      // Bob should not have the handle, i.e. Alice should not have forwarded
      // the messages from charlie
      assert.equal(Object.entries(bob2.handles).length, 0)
    })
  })
})
