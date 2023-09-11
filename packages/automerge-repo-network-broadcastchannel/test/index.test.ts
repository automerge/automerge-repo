import { BroadcastChannelNetworkAdapter } from "../src/index.js"
import {
  type SetupFn,
  runAdapterTests,
} from "../../automerge-repo/src/helpers/tests/network-adapter-tests.js"
import { PeerId } from "@automerge/automerge-repo"

describe("BroadcastChannel", () => {
  const setup: SetupFn = async () => {
    const a = new BroadcastChannelNetworkAdapter()
    const b = new BroadcastChannelNetworkAdapter()
    const c = new BroadcastChannelNetworkAdapter()

    return { adapters: [a, b, c] }
  }

  runAdapterTests(setup)

  it("should allow a channel name to be specified in the options", async () => {
    const a = new BroadcastChannelNetworkAdapter({ channelName: "test" })
    const b = new BroadcastChannelNetworkAdapter({ channelName: "test" })

    // this adapter should never connect
    const c = new BroadcastChannelNetworkAdapter()

    const aConnect = new Promise<void>(resolve => {
      a.once("peer-candidate", () => resolve())
    })

    const cShouldNotConnect = new Promise<void>((resolve, reject) => {
      c.once("peer-candidate", () => reject("c should not connect"))

      setTimeout(() => {
        resolve()
      }, 100)
    })

    a.connect("a" as PeerId)
    b.connect("b" as PeerId)

    return Promise.all([aConnect, cShouldNotConnect])
  })
})
