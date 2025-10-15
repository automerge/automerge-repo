import { renderHook, act, waitFor } from "@testing-library/react"
import { describe, expect, test } from "vitest"
import { MessageChannelNetworkAdapter } from "../../automerge-repo-network-messagechannel/src/index.js"
import { useLocalAwareness } from "../src/useLocalAwareness.js"
import { useRemoteAwareness } from "../src/useRemoteAwareness.js"
import { Repo, PeerId } from "@automerge/automerge-repo"

function setupMesh(n = 2) {
  const abChannel = new MessageChannel()

  const { port1: ab, port2: ba } = abChannel

  const alice = "alice" as PeerId
  const aliceRepo = new Repo({
    network: [new MessageChannelNetworkAdapter(ab)],
    peerId: alice,
  })

  const bob = "bob" as PeerId
  const bobRepo = new Repo({
    network: [new MessageChannelNetworkAdapter(ba)],
    peerId: bob,
  })

  return { alice, bob, aliceRepo, bobRepo }
}

describe("use{Local,Remote}Awareness", () => {
  test("it should allow a user to create a local awareness", () => {
    const repo = new Repo({ network: [] })
    const handle = repo.create("Hello World")

    const { result, rerender } = renderHook(() =>
      useLocalAwareness({
        handle,
        userId: "alice",
        initialState: "Hello World",
      })
    )

    const [state, setState] = result.current

    expect(state).toEqual("Hello World")

    act(() => {
      setState("Goodbye")
    })

    rerender()

    const [state2, setState2] = result.current

    expect(state2).toEqual("Goodbye")
  })

  test("it should show state on remote awareness for same doc handle", () => {
    const userId = "alice"
    const initialState = "Hello World"

    const repo = new Repo({ network: [] })
    const handle = repo.create("Hello World")

    const { result, rerender } = renderHook(() => [
      useLocalAwareness({
        handle,
        userId,
        initialState,
      }),
      useRemoteAwareness({
        handle,
        localUserId: userId,
      }),
    ])

    const [local, remote] = result.current

    const [peerStates, heartbeats] = remote

    // For just the local peer it should ignore itself
    expect(peerStates).toEqual({})
    expect(heartbeats).toEqual({})
  })

  test("it should send local state from alice to remote state of bob", async () => {
    let timeCount = 0
    function getTime() {
      return timeCount++
    }

    const initialState = "Hello World"
    const { alice, bob, aliceRepo, bobRepo } = setupMesh()

    const aliceHandle = aliceRepo.create("Hello World")
    const bobHandle = bobRepo.find(aliceHandle.url)

    const { result: resultA, rerender: rerenderA } = renderHook(() => [
      useLocalAwareness({
        handle: aliceHandle,
        userId: alice,
        initialState,
      }),
      useRemoteAwareness({
        handle: aliceHandle,
        localUserId: alice,
        getTime,
      }),
    ])

    // TODO: Need to wait for initialization somehow?
    await new Promise(resolve => setTimeout(resolve, 100))

    const { result: resultB, rerender: rerenderB } = renderHook(() => [
      useLocalAwareness({
        handle: bobHandle,
        userId: bob,
        initialState,
      }),
      useRemoteAwareness({
        handle: bobHandle,
        localUserId: bob,
        getTime,
      }),
    ])

    await waitFor(() => {
      rerenderA()
      rerenderB()
      const [localB, remoteB] = resultB.current

      const [peerStates, heartbeats] = remoteB

      // For just the local peer it should ignore itself
      expect(peerStates).toEqual({ [alice]: initialState })
      // expect two heartbeats from alice
      // their inital, then second once seeing bob
      expect(heartbeats).toEqual({ [alice]: 2 })
    })
  })
})

// basic send/receive
// it should allow a user to set a local awareness
// it should not notify the local peer when they set a local awareness
// it should return another peer's awareness when it gets set remotely
// heartbeats & timeouts
// it should remove a peer that hasn't sent an update since the heartbeat timeout
// it should send a heartbeat at an configurable interval
// multiple docs
// it shouldn't receive awareness across docs
// multiple clients with awareness
// when there are more than one client with the same userid it shouldn't compete for the same awareness
// if a user has two clients, the value should be the last one set by the user (most recent wins)
