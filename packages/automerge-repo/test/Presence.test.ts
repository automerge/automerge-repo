import { describe, expect, it, vi } from "vitest"

import { Presence } from "../src/presence/Presence.js"
import { PresenceEventHeartbeat } from "../src/presence/types.js"
import { Repo } from "../src/Repo.js"
import { PeerId } from "../src/types.js"
import { DummyNetworkAdapter } from "../src/helpers/DummyNetworkAdapter.js"
import { waitFor } from "./helpers/waitFor.js"

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
    })

    const bobHandle = await bob.find(aliceHandle.url)
    const bobPresence = new Presence<PresenceState>({
      handle: bobHandle,
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
        const bobPeerStates = bob.presence.getPeerStates().value
        const bobPeers = Object.keys(bobPeerStates)

        expect(bobPeers.length).toBe(1)
        expect(bobPeers[0]).toBe(alice.repo.peerId)
        expect(bobPeerStates[alice.repo.peerId].value.position).toBe(123)

        const alicePeerStates = alice.presence.getPeerStates().value
        const alicePeers = Object.keys(alicePeerStates)

        expect(alicePeers.length).toBe(1)
        expect(alicePeers[0]).toBe(bob.repo.peerId)
        expect(alicePeerStates[bob.repo.peerId].value.position).toBe(456)
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
        const bobPeerStates = bob.presence.getPeerStates().value
        const bobPeers = Object.keys(bobPeerStates)

        expect(bobPeers.length).toBe(1)
        expect(bobPeers[0]).toBe(alice.repo.peerId)
        expect(bobPeerStates[alice.repo.peerId].value.position).toBe(123)
      })

      alice.presence.stop()
      expect(alice.presence.running).toBe(false)

      console.log("waiting for peers to leave")
      await waitFor(() => {
        const bobPeerStates = bob.presence.getPeerStates().value
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
      })
    })

    it("delays heartbeats when there is a state update", async () => {
      // setup() runs a real network handshake, so install fake timers only
      // afterwards. DummyNetworkAdapter delivers on a microtask rather than a
      // timer, and advanceTimersByTimeAsync flushes microtasks between ticks,
      // so heartbeats still round-trip to bob deterministically. With real
      // timers these short waits overshoot the 10ms interval under CI load and
      // the heartbeat fires before the "still delayed" assertion.
      const { alice, bob } = await setup()
      vi.useFakeTimers()
      try {
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

        await vi.advanceTimersByTimeAsync(7)
        // A state update resets the heartbeat timer, so the next heartbeat is
        // a full interval (10ms) away again.
        alice.presence.broadcast("position", 789)
        await vi.advanceTimersByTimeAsync(7)

        // Only 7ms have elapsed since the reset (< 10ms), so no heartbeat has
        // been sent yet.
        expect(hbPeerMsg).toBeUndefined()

        await vi.advanceTimersByTimeAsync(20)
        expect(hbPeerMsg.peerId).toEqual(alice.repo.peerId)
        expect(hbPeerMsg.type).toEqual("heartbeat")
      } finally {
        vi.useRealTimers()
      }
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
        const bobPeerStates = bob.presence.getPeerStates().value
        const bobPeers = Object.keys(bobPeerStates)

        expect(bobPeers.length).toBe(1)
        expect(bobPeerStates[alice.repo.peerId].value.position).toBe(123)
      })

      alice.presence.broadcast("position", 213)

      await waitFor(() => {
        const bobPeerStates = bob.presence.getPeerStates().value
        const bobPeers = Object.keys(bobPeerStates)

        expect(bobPeers.length).toBe(1)
        expect(bobPeerStates[alice.repo.peerId].value.position).toBe(213)
      })
    })
  })
})
