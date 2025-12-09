import { describe, expect, it } from "vitest"

import { Presence, PresenceEventHeartbeat } from "../src/Presence.js"
import { Repo } from "../src/Repo.js"
import { PeerId } from "../src/types.js"
import { DummyNetworkAdapter } from "../src/helpers/DummyNetworkAdapter.js"
import { waitFor } from "./helpers/waitFor.js"
import { wait } from "./helpers/wait.js"

type PresenceState = { position: number }

describe("Presence", () => {
  async function setup(opts?: { skipAnnounce?: boolean }) {
    const alice = new Repo({ peerId: "alice" as PeerId })
    const bob = new Repo({ peerId: "bob" as PeerId })
    const [aliceToBob, bobToAlice] = DummyNetworkAdapter.createConnectedPair()
    alice.networkSubsystem.addNetworkAdapter(aliceToBob)
    bob.networkSubsystem.addNetworkAdapter(bobToAlice)
    if (!opts?.skipAnnounce) {
      aliceToBob.peerCandidate("bob" as PeerId)
      bobToAlice.peerCandidate("alice" as PeerId)
    }
    await Promise.all([
      alice.networkSubsystem.whenReady(),
      bob.networkSubsystem.whenReady(),
    ])

    const aliceHandle = alice.create({
      test: "doc",
    })
    const alicePresence = new Presence<PresenceState>({
      handle: aliceHandle,
      userId: "alice",
      deviceId: "phone",
    })

    const bobHandle = await bob.find(aliceHandle.url)
    const bobPresence = new Presence<PresenceState>({
      handle: bobHandle,
      userId: "bob",
      deviceId: "phone",
    })

    return {
      alice: {
        repo: alice,
        handle: aliceHandle,
        presence: alicePresence,
        network: aliceToBob,
      },
      bob: {
        repo: bob,
        handle: bobHandle,
        presence: bobPresence,
        network: bobToAlice,
      },
    }
  }

  describe("start", () => {
    it("activates presence and shares initial state", async () => {
      const { alice, bob } = await setup()

      alice.presence.start({
        initialState: {
          position: 123,
        },
      })
      expect(alice.presence.running).toBe(true)

      bob.presence.start({
        initialState: {
          position: 456,
        },
      })
      expect(bob.presence.running).toBe(true)

      await waitFor(() => {
        const bobPeerStates = bob.presence.getPeerStates()
        const bobPeers = Object.keys(bobPeerStates)

        expect(bobPeers.length).toBe(1)
        expect(bobPeers[0]).toBe(alice.repo.peerId)
        expect(bobPeerStates[bobPeers[0]].state.value.position).toBe(123)

        const alicePeerStates = alice.presence.getPeerStates()
        const alicePeers = Object.keys(alicePeerStates)

        expect(alicePeers.length).toBe(1)
        expect(alicePeers[0]).toBe(bob.repo.peerId)
        expect(alicePeerStates[alicePeers[0]].state.value.position).toBe(456)
      })
    })

    it("does nothing if invoked on an already-running Presence", async () => {
      const { alice } = await setup()

      alice.presence.start({
        initialState: {
          position: 123,
        },
      })
      expect(alice.presence.running).toBe(true)

      alice.presence.start({
        initialState: {
          position: 789,
        },
      })
      expect(alice.presence.running).toBe(true)
      expect(alice.presence.getLocalState().position).toBe(123)
    })
  })

  describe("stop", () => {
    it("stops running presence and ignores further broadcasts", async () => {
      const { alice, bob } = await setup()

      alice.presence.start({
        initialState: {
          position: 123,
        },
      })
      expect(alice.presence.running).toBe(true)

      bob.presence.start({
        initialState: {
          position: 456,
        },
      })

      await waitFor(() => {
        const bobPeerStates = bob.presence.getPeerStates()
        const bobPeers = Object.keys(bobPeerStates)

        expect(bobPeers.length).toBe(1)
        expect(bobPeers[0]).toBe(alice.repo.peerId)
        expect(bobPeerStates[bobPeers[0]].state.value.position).toBe(123)
      })

      alice.presence.stop()
      expect(alice.presence.running).toBe(false)

      await waitFor(() => {
        const bobPeerStates = bob.presence.getPeerStates()
        const bobPeers = Object.keys(bobPeerStates)

        expect(bobPeers.length).toBe(0)
      })
    })

    it("does nothing if invoked on a non-running Presence", async () => {
      const { alice } = await setup()

      expect(alice.presence.running).toBe(false)

      alice.presence.stop()

      expect(alice.presence.running).toBe(false)
    })
  })

  describe("heartbeats", () => {
    it("sends heartbeats on the configured interval", async () => {
      const { alice, bob } = await setup()
      alice.presence.start({
        initialState: {
          position: 123,
        },
        heartbeatMs: 10,
      })

      bob.presence.start({
        initialState: {
          position: 456,
        },
      })

      let hbPeerMsg: PresenceEventHeartbeat
      bob.presence.on("heartbeat", msg => {
        hbPeerMsg = msg
      })

      await waitFor(() => {
        expect(hbPeerMsg.peerId).toEqual(alice.repo.peerId)
        expect(hbPeerMsg.type).toEqual("heartbeat")
        expect(hbPeerMsg.userId).toEqual("alice")
      })
    })

    it("delays heartbeats when there is a state update", async () => {
      const { alice, bob } = await setup()
      alice.presence.start({
        initialState: {
          position: 123,
        },
        heartbeatMs: 10,
      })

      bob.presence.start({
        initialState: {
          position: 456,
        },
      })

      let hbPeerMsg: PresenceEventHeartbeat
      bob.presence.on("heartbeat", msg => {
        hbPeerMsg = msg
      })

      await wait(7)
      alice.presence.broadcast("position", 789)
      await wait(7)

      expect(hbPeerMsg).toBeUndefined()

      await wait(20)
      expect(hbPeerMsg.peerId).toEqual(alice.repo.peerId)
      expect(hbPeerMsg.type).toEqual("heartbeat")
      expect(hbPeerMsg.userId).toEqual("alice")
    })
  })

  describe("broadcast", () => {
    it("sends updates to peers", async () => {
      const { alice, bob } = await setup()
      alice.presence.start({
        initialState: {
          position: 123,
        },
      })

      bob.presence.start({
        initialState: {
          position: 456,
        },
      })

      await waitFor(() => {
        const bobPeerStates = bob.presence.getPeerStates()
        const bobPeers = Object.keys(bobPeerStates)

        expect(bobPeers.length).toBe(1)
        expect(bobPeerStates[alice.repo.peerId].value.position).toBe(123)
      })

      alice.presence.broadcast("position", 213)

      await waitFor(() => {
        const bobPeerStates = bob.presence.getPeerStates()
        const bobPeers = Object.keys(bobPeerStates)

        expect(bobPeers.length).toBe(1)
        expect(bobPeerStates[alice.repo.peerId].value.position).toBe(213)
      })
    })
  })
})
