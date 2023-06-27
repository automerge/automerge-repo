import { BroadcastChannelNetworkAdapter } from "../src"
import {
  type SetupFn,
  runAdapterTests,
} from "../../automerge-repo/src/helpers/tests/network-adapter-tests"

describe("BroadcastChannel", () => {
  const setup: SetupFn = async () => {
    const a = new BroadcastChannelNetworkAdapter()
    const b = new BroadcastChannelNetworkAdapter()
    const c = new BroadcastChannelNetworkAdapter()

    return { adapters: [a, b, c] }
  }

  runAdapterTests(setup)
})
