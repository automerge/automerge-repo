import { afterEach, describe, expect, it, vi } from "vitest"

import { Presence } from "../src/presence/Presence.js"
import {
  originIdentity,
  senderIdentity,
} from "../src/presence/PeerStateView.js"
import type {
  PresenceEventHeartbeat,
  PresenceEventPruning,
} from "../src/presence/types.js"
import { Repo } from "../src/Repo.js"
import { setLoggerFactory } from "../src/Logger.js"
import type { DocHandle } from "../src/DocHandle.js"
import type { RepoId } from "../src/types.js"
import { EphemeralHub } from "./helpers/ephemeralHub.js"

type PresenceState = { position: number }

let hub: EphemeralHub
const repos: Repo[] = []
const presences: Presence<PresenceState>[] = []

afterEach(async () => {
  vi.useRealTimers()
  setLoggerFactory(() => console)
  presences.splice(0).forEach(presence => presence.stop())
  await Promise.all(repos.splice(0).map(repo => repo.shutdown()))
  await hub?.close()
})

/** Repos on one document; each entry names the sender it publishes as. */
async function setup<const Names extends string>(
  senders: Record<Names, string>
) {
  hub = new EphemeralHub()
  const peers = {} as Record<
    Names,
    {
      repo: Repo
      handle: DocHandle<unknown>
      presence: Presence<PresenceState>
    }
  >
  let url: string | undefined
  for (const [name, sender] of Object.entries<string>(senders)) {
    const repo = new Repo({
      backend: hub.backend(sender),
      id: name as RepoId,
    })
    repos.push(repo)
    const handle: DocHandle<unknown> = url
      ? await repo.find(url)
      : await repo.create({ test: "doc" })
    url = handle.url
    const presence = new Presence<PresenceState>({ handle })
    presences.push(presence)
    peers[name as Names] = { repo, handle, presence }
  }
  return peers
}

function states(presence: Presence<PresenceState>) {
  return Object.values(presence.getPeerStates().value)
}

function positions(presence: Presence<PresenceState>) {
  return Object.fromEntries(
    states(presence).map(state => [state.originId, state.value.position])
  )
}

describe("Presence", () => {
  describe("start", () => {
    it("activates presence and shares initial state", async () => {
      const { alice, bob } = await setup({ alice: "alice", bob: "bob" })

      alice.presence.start({ initialState: { position: 123 } })
      expect(alice.presence.running).toBe(true)
      bob.presence.start({ initialState: { position: 456 } })
      expect(bob.presence.running).toBe(true)

      await vi.waitFor(() => {
        expect(states(bob.presence)).toEqual([
          expect.objectContaining({
            senderId: "alice",
            originId: alice.repo.id,
            value: { position: 123 },
          }),
        ])
        expect(states(alice.presence)).toEqual([
          expect.objectContaining({
            senderId: "bob",
            originId: bob.repo.id,
            value: { position: 456 },
          }),
        ])
      })
    })

    it("does nothing if invoked on an already-running Presence", async () => {
      const { alice } = await setup({ alice: "alice" })

      alice.presence.start({ initialState: { position: 123 } })
      alice.presence.start({ initialState: { position: 789 } })
      expect(alice.presence.running).toBe(true)
      expect(alice.presence.getLocalState().position).toBe(123)
    })

    it("ignores ephemeral messages that are not presence messages", async () => {
      const { alice, bob } = await setup({ alice: "alice", bob: "bob" })
      const error = vi.fn()
      setLoggerFactory(() => ({ ...console, error }))
      bob.presence.start({ initialState: { position: 456 } })
      alice.handle.broadcast("not presence")
      alice.handle.broadcast(null)
      alice.handle.broadcast({ other: true })
      alice.presence.start({ initialState: { position: 123 } })

      await vi.waitFor(() =>
        expect(positions(bob.presence)).toEqual({ alice: 123 })
      )
      // A throwing listener would be logged by the handle registry.
      expect(error).not.toHaveBeenCalled()
    })
  })

  describe("stop", () => {
    it("stops running presence and ignores further broadcasts", async () => {
      const { alice, bob } = await setup({ alice: "alice", bob: "bob" })
      alice.presence.start({ initialState: { position: 123 } })
      bob.presence.start({ initialState: { position: 456 } })
      await vi.waitFor(() =>
        expect(positions(bob.presence)).toEqual({ alice: 123 })
      )

      alice.presence.stop()
      expect(alice.presence.running).toBe(false)
      alice.presence.broadcast("position", 789)

      await vi.waitFor(() => expect(states(bob.presence)).toEqual([]))
    })

    it("does nothing if invoked on a non-running Presence", async () => {
      const { alice } = await setup({ alice: "alice" })
      alice.presence.stop()
      expect(alice.presence.running).toBe(false)
    })
  })

  describe("heartbeats", () => {
    it("sends heartbeats on the configured interval", async () => {
      const { alice, bob } = await setup({ alice: "alice", bob: "bob" })
      alice.presence.start({ initialState: { position: 123 }, heartbeatMs: 10 })
      bob.presence.start({ initialState: { position: 456 } })

      let heartbeat: PresenceEventHeartbeat | undefined
      bob.presence.on("heartbeat", event => {
        heartbeat = event
      })

      await vi.waitFor(() =>
        expect(heartbeat).toMatchObject({
          type: "heartbeat",
          senderId: "alice",
          originId: alice.repo.id,
        })
      )
    })

    it("delays heartbeats when there is a state update", async () => {
      const { alice, bob } = await setup({ alice: "alice", bob: "bob" })
      vi.useFakeTimers()
      alice.presence.start({ initialState: { position: 123 }, heartbeatMs: 10 })
      bob.presence.start({ initialState: { position: 456 } })

      let heartbeat: PresenceEventHeartbeat | undefined
      bob.presence.on("heartbeat", event => {
        heartbeat = event
      })

      await vi.advanceTimersByTimeAsync(7)
      // A state update resets the heartbeat timer.
      alice.presence.broadcast("position", 789)
      await vi.advanceTimersByTimeAsync(7)
      expect(heartbeat).toBeUndefined()

      await vi.advanceTimersByTimeAsync(20)
      expect(heartbeat).toMatchObject({ type: "heartbeat", senderId: "alice" })
    })
  })

  describe("broadcast", () => {
    it("sends updates to peers", async () => {
      const { alice, bob } = await setup({ alice: "alice", bob: "bob" })
      alice.presence.start({ initialState: { position: 123 } })
      bob.presence.start({ initialState: { position: 456 } })
      await vi.waitFor(() =>
        expect(positions(bob.presence)).toEqual({ alice: 123 })
      )

      alice.presence.broadcast("position", 213)

      await vi.waitFor(() =>
        expect(positions(bob.presence)).toEqual({ alice: 213 })
      )
    })
  })

  describe("Repos sharing one sender", () => {
    const senders = { tab1: "device", tab2: "device", bob: "bob" }

    it("keeps one peer per publishing Repo, as seen remotely and by siblings", async () => {
      const { tab1, tab2, bob } = await setup(senders)
      tab1.presence.start({ initialState: { position: 1 } })
      tab2.presence.start({ initialState: { position: 2 } })
      bob.presence.start({ initialState: { position: 3 } })

      await vi.waitFor(() => {
        expect(positions(bob.presence)).toEqual({ tab1: 1, tab2: 2 })
        expect(positions(tab1.presence)).toEqual({ tab2: 2, bob: 3 })
        expect(positions(tab2.presence)).toEqual({ tab1: 1, bob: 3 })
      })
      expect(
        states(bob.presence).every(state => state.senderId === "device")
      ).toBe(true)

      tab1.presence.broadcast("position", 10)
      await vi.waitFor(() =>
        expect(positions(bob.presence)).toEqual({ tab1: 10, tab2: 2 })
      )
    })

    it("groups by origin by default and by sender on request", async () => {
      const { tab1, tab2, bob } = await setup(senders)
      vi.useFakeTimers()
      bob.presence.start({ initialState: { position: 3 } })
      tab1.presence.start({ initialState: { position: 1 } })
      tab2.presence.start({ initialState: { position: 2 } })
      // Let every announcement go out, then make tab2 the last active Repo.
      await vi.advanceTimersByTimeAsync(2000)
      tab2.presence.broadcast("position", 20)
      await vi.advanceTimersByTimeAsync(10)
      expect(positions(bob.presence)).toEqual({ tab1: 1, tab2: 20 })

      const view = bob.presence.getPeerStates()
      const byOrigin = view.getStates()
      expect(Object.keys(byOrigin).sort()).toEqual(["tab1", "tab2"])
      expect(view.getStates({ groupingFn: originIdentity })).toEqual(byOrigin)
      const bySender = view.getStates({ groupingFn: senderIdentity })
      expect(Object.keys(bySender)).toEqual(["device"])
      expect(bySender.device).toMatchObject({
        originId: "tab2",
        value: { position: 20 },
      })
    })

    it("re-announces to a new Repo behind an already known sender", async () => {
      const { tab1, tab2, bob } = await setup(senders)
      vi.useFakeTimers()
      bob.presence.start({ initialState: { position: 3 } })
      tab1.presence.start({ initialState: { position: 1 } })
      // Let every announcement of this first exchange go out.
      await vi.advanceTimersByTimeAsync(2000)
      expect(positions(tab1.presence)).toEqual({ bob: 3 })

      // Heartbeats are far off: tab2 can only learn bob's state from bob's
      // announcement on seeing a new peer.
      tab2.presence.start({ initialState: { position: 2 } })
      await vi.advanceTimersByTimeAsync(1000)
      expect(positions(tab2.presence)).toEqual({ tab1: 1, bob: 3 })
    })

    it("forgets only the Repo that said goodbye", async () => {
      const { tab1, tab2, bob } = await setup(senders)
      tab1.presence.start({ initialState: { position: 1 } })
      tab2.presence.start({ initialState: { position: 2 } })
      bob.presence.start({ initialState: { position: 3 } })
      await vi.waitFor(() =>
        expect(positions(bob.presence)).toEqual({ tab1: 1, tab2: 2 })
      )

      const goodbye = vi.fn()
      bob.presence.on("goodbye", goodbye)
      tab1.presence.stop()

      await vi.waitFor(() =>
        expect(positions(bob.presence)).toEqual({ tab2: 2 })
      )
      expect(goodbye).toHaveBeenCalledOnce()
      expect(goodbye).toHaveBeenCalledWith(
        expect.objectContaining({ senderId: "device", originId: "tab1" })
      )
      expect(positions(tab2.presence)).toEqual({ bob: 3 })
    })

    it("prunes only the Repo that went silent", async () => {
      const { tab1, tab2, bob } = await setup(senders)
      vi.useFakeTimers()
      const config = { heartbeatMs: 10, peerTtlMs: 50 }
      tab1.presence.start({ initialState: { position: 1 }, ...config })
      tab2.presence.start({ initialState: { position: 2 }, ...config })
      bob.presence.start({ initialState: { position: 3 }, ...config })
      await vi.advanceTimersByTimeAsync(20)
      expect(positions(bob.presence)).toEqual({ tab1: 1, tab2: 2 })

      const pruning: PresenceEventPruning[] = []
      bob.presence.on("pruning", event => pruning.push(event))
      // tab1 crashes: nothing more from it arrives, not even a goodbye.
      hub.drop = message => message.origin.id === "tab1"
      await vi.advanceTimersByTimeAsync(100)

      expect(positions(bob.presence)).toEqual({ tab2: 2 })
      expect(pruning).toEqual([{ pruned: ["tab1"] }])
    })
  })
})
