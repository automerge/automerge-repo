import { PeerId } from "@automerge/automerge-repo"
import { describe, expect, it, vi } from "vitest"
import {
  runNetworkAdapterTests,
  type SetupFn,
} from "../../automerge-repo/src/helpers/tests/network-adapter-tests.js"
import { BroadcastChannelNetworkAdapter } from "../src/index.js"
import { pause } from "../../automerge-repo/src/helpers/pause.js"

describe("BroadcastChannel", () => {
  const setup: SetupFn = async () => {
    // Isolate each test on its own channel. A shared channel lets stale
    // adapters from another test in the same process answer "arrive" with
    // "welcome", which fires extra peer-candidate events for the same
    // peerIds and resets per-peer sync state mid-test.
    const channelName = `broadcast-${Math.random().toString(36).slice(2)}`
    const a = new BroadcastChannelNetworkAdapter({ channelName })
    const b = new BroadcastChannelNetworkAdapter({ channelName })
    const c = new BroadcastChannelNetworkAdapter({ channelName })

    return {
      adapters: [a, b, c],
      teardown: () => {
        a.disconnect()
        b.disconnect()
        c.disconnect()
      },
    }
  }

  runNetworkAdapterTests(setup)

  it("allows a channel name to be specified in the options and limits messages to that channel", async () => {
    const a = new BroadcastChannelNetworkAdapter()
    const b = new BroadcastChannelNetworkAdapter()

    // this adapter should never connect
    const c = new BroadcastChannelNetworkAdapter({ channelName: "other" })

    const aConnect = new Promise<void>(resolve => {
      a.once("peer-candidate", () => resolve())
    })

    const cShouldNotConnect = new Promise<void>((resolve, reject) => {
      c.once("peer-candidate", () => reject(new Error("c should not connect")))

      setTimeout(() => {
        resolve()
      }, 100)
    })

    a.connect("a" as PeerId)
    b.connect("b" as PeerId)
    c.connect("c" as PeerId)

    return Promise.all([aConnect, cShouldNotConnect])
  })

  it("allows a wait time to be specified in the options and is ready after that even if no peers have connected", async () => {
    const a = new BroadcastChannelNetworkAdapter({
      channelName: "a",
      peerWaitMs: 10,
    })
    await pause(10)
    expect(a.isReady()).toBe(true)
  })

  it("removes its listener and closes its channel on disconnect, and is idempotent", () => {
    const channelName = `broadcast-${Math.random().toString(36).slice(2)}`
    // Spy on the prototype and assert on deltas so other adapters in the
    // process don't perturb the counts.
    const removeSpy = vi.spyOn(
      BroadcastChannel.prototype,
      "removeEventListener"
    )
    const closeSpy = vi.spyOn(BroadcastChannel.prototype, "close")
    try {
      const a = new BroadcastChannelNetworkAdapter({ channelName })
      a.connect("a-peer" as PeerId)

      const removesBefore = removeSpy.mock.calls.length
      const closesBefore = closeSpy.mock.calls.length

      a.disconnect()
      expect(removeSpy.mock.calls.length).toBe(removesBefore + 1)
      expect(closeSpy.mock.calls.length).toBe(closesBefore + 1)

      // A second disconnect is a no-op: it must not throw or touch the channel
      // again (the channel is already closed).
      expect(() => a.disconnect()).not.toThrow()
      expect(closeSpy.mock.calls.length).toBe(closesBefore + 1)
    } finally {
      removeSpy.mockRestore()
      closeSpy.mockRestore()
    }
  })
})
