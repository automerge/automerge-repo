import { BroadcastChannelNetworkAdapter } from "../src"
import { SetupFn, runAdapterTests } from "@automerge/automerge-repo"

describe("BroadcastChannel", () => {
  const setup: SetupFn = async () => {
    const a = new BroadcastChannelNetworkAdapter()
    const b = new BroadcastChannelNetworkAdapter()
    const c = new BroadcastChannelNetworkAdapter()
    return { adapters: [a, b, c] }
  }

  runAdapterTests(setup)
})
