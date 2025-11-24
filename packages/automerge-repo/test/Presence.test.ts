import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  Presence,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  PresenceEventHeartbeat,
} from "../src/Presence.js"
import { Repo } from "../src/Repo.js"
import { PeerId } from "../src/types.js"
import { DummyNetworkAdapter } from "../src/helpers/DummyNetworkAdapter.js"
import { waitFor } from "./helpers/waitFor.js"

describe("Presence", () => {
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
      const alicePresence = new Presence(aliceHandle, "alice", "phone", {
        position: 123,
      })

      const bobHandle = await bob.find(aliceHandle.url)
      const bobPresence = new Presence(bobHandle, "bob", "phone", {
        position: 456,
      })

      await waitFor(() => {
        const bobPeerStates = bobPresence.getPeerStates()
        const bobPeers = bobPeerStates.getPeers()

        expect(bobPeers.length).toBe(1)
        expect(bobPeerStates.getPeerState(bobPeers[0], "position")).toBe(123)

        const alicePeerStates = alicePresence.getPeerStates()
        const alicePeers = alicePeerStates.getPeers()

        expect(alicePeers.length).toBe(1)
        expect(alicePeerStates.getPeerState(alicePeers[0], "position")).toBe(
          456
        )
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
        "phone",
        {
          position: 123,
        },
        {
          heartbeatMs: 10,
        }
      )

      const bobHandle = await bob.find(aliceHandle.url)
      const bobPresence = new Presence(bobHandle, "bob", "phone", {
        position: 456,
      })

      let hbPeerMsg: PresenceEventHeartbeat
      bobPresence.on("heartbeat", msg => {
        hbPeerMsg = msg
      })

      await waitFor(() => {
        expect(hbPeerMsg.peerId).toEqual(alice.peerId)
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
      const alicePresence = new Presence(aliceHandle, "alice", "phone", {
        position: 123,
      })

      const bobHandle = await bob.find(aliceHandle.url)
      const bobPresence = new Presence(bobHandle, "bob", "phone", {
        position: 456,
      })

      alicePresence.broadcast("position", 213)

      await waitFor(() => {
        const bobPeerStates = bobPresence.getPeerStates()
        const bobPeers = bobPeerStates.getPeers()

        expect(bobPeers.length).toBe(1)
        expect(bobPeerStates.getPeerState(alice.peerId, "position")).toBe(213)
      })
    })

    it.skip("immediately sends current state to new peers")
    it.skip("tracks user status across several peers with the same userId")
  })
})
