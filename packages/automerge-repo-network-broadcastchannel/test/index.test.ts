import { PeerId } from "@automerge/automerge-repo"
import { describe, it } from "vitest"
import {
  runNetworkAdapterTests,
  type SetupFn,
} from "../../automerge-repo/src/helpers/tests/network-adapter-tests.js"
import { BroadcastChannelNetworkAdapter } from "../src/index.js"

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
})
