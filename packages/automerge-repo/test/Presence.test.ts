import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  Presence,
  PresenceMessageHeartbeat,
  HEARTBEAT_INTERVAL_MS,
} from "../src/Presence.js"
import { Repo } from "../src/Repo.js"
import { PeerId } from "../src/types.js"
import { DummyNetworkAdapter } from "../src/helpers/DummyNetworkAdapter.js"
import { waitFor } from "./helpers/waitFor.js"

describe("Repo", () => {
  async function setup() {
    const alice = new Repo({ peerId: "alice" as PeerId })
    const bob = new Repo({ peerId: "bob" as PeerId })
    const [aliceToBob, bobToAlice] = DummyNetworkAdapter.createConnectedPair()
    alice.networkSubsystem.addNetworkAdapter(aliceToBob)
    bob.networkSubsystem.addNetworkAdapter(bobToAlice)
    aliceToBob.peerCandidate("bob" as PeerId)
    bobToAlice.peerCandidate("alice" as PeerId)
    await Promise.all([
      alice.networkSubsystem.whenReady(),
      bob.networkSubsystem.whenReady(),
    ])
    return [alice, bob]
  }

  describe("constructor", () => {
    it("shares initial state", async () => {
      const [alice, bob] = await setup()
      const aliceHandle = alice.create({
        test: "doc",
      })
      const alicePresence = new Presence(aliceHandle, "alice", {
        position: 123,
      })

      const bobHandle = await bob.find(aliceHandle.url)
      const bobPresence = new Presence(bobHandle, "bob", {
        position: 456,
      })

      await waitFor(() => {
        const bobPeerMap = bobPresence.getPeerStates("position")
        expect(bobPeerMap.size).toBe(1)
        expect(bobPeerMap.get(alice.peerId)).toBe(123)

        const alicePeerMap = alicePresence.getPeerStates("position")
        expect(alicePeerMap.size).toBe(1)
        expect(alicePeerMap.get(bob.peerId)).toBe(456)
      })
    })
  })

  describe("heartbeats", () => {
    it("sends heartbeats on the configured interval", async () => {
      const [alice, bob] = await setup()
      const aliceHandle = alice.create({
        test: "doc",
      })
      const alicePresence = new Presence(
        aliceHandle,
        "alice",
        {
          position: 123,
        },
        {
          heartbeatMs: 10,
        }
      )

      const bobHandle = await bob.find(aliceHandle.url)
      const bobPresence = new Presence(bobHandle, "bob", {
        position: 456,
      })

      let hbPeerId: PeerId
      let hbPeerMsg: PresenceMessageHeartbeat
      bobPresence.on("heartbeat", (peerId, msg) => {
        hbPeerId = peerId
        hbPeerMsg = msg
      })

      await waitFor(() => {
        expect(hbPeerId).toEqual(alice.peerId)
        expect(hbPeerMsg.type).toEqual("heartbeat")
        expect(hbPeerMsg.userId).toEqual("alice")
      })
    })

    it.skip("delays heartbeats when there is a state update")
  })

  describe("state", () => {
    it("sends updates to peers", async () => {
      const [alice, bob] = await setup()
      const aliceHandle = alice.create({
        test: "doc",
      })
      const alicePresence = new Presence(aliceHandle, "alice", {
        position: 123,
      })

      const bobHandle = await bob.find(aliceHandle.url)
      const bobPresence = new Presence(bobHandle, "bob", {
        position: 456,
      })

      alicePresence.broadcast("position", 213)

      await waitFor(() => {
        const bobPeerMap = bobPresence.getPeerStates("position")
        expect(bobPeerMap.size).toBe(1)
        expect(bobPeerMap.get(alice.peerId)).toBe(213)
      })
    })

    it.skip("immediately sends current state to new peers")
    it.skip("tracks user status across several peers with the same userId")
  })
})
