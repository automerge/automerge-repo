import { BroadcastChannelNetworkAdapter } from "../src"
import {
  SetupFn,
  runAdapterTests,
} from "automerge-repo-network-acceptance-tests"

describe("BroadcastChannel", () => {
  const setup: SetupFn = async () => {
    const a = new BroadcastChannelNetworkAdapter()
    const b = new BroadcastChannelNetworkAdapter()
    return { adapters: [a, b] }
  }

  runAdapterTests(setup)
})
