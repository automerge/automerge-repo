import { PeerId } from "@automerge/automerge-repo"
import { describe, expect, it } from "vitest"
import {
  runNetworkAdapterTests,
  type SetupFn,
} from "../../automerge-repo/src/helpers/tests/network-adapter-tests.js"
import { BroadcastChannelNetworkAdapter } from "../src/index.js"
import { pause } from "../../automerge-repo/src/helpers/pause.js"

describe("BroadcastChannel", () => {
  const setup: SetupFn = async () => {
    const a = new BroadcastChannelNetworkAdapter()
    const b = new BroadcastChannelNetworkAdapter()
    const c = new BroadcastChannelNetworkAdapter()

    return { adapters: [a, b, c] }
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
})
