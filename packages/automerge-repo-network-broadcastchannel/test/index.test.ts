import { BroadcastChannelNetworkAdapter } from "../src/index.js"
import {
  type SetupFn,
  runAdapterTests,
} from "../../automerge-repo/src/helpers/tests/network-adapter-tests.js"

describe("BroadcastChannel", () => {
  const setup: SetupFn = async () => {
    const a = new BroadcastChannelNetworkAdapter()
    const b = new BroadcastChannelNetworkAdapter()
    const c = new BroadcastChannelNetworkAdapter()

    return { adapters: [a, b, c] }
  }

  runAdapterTests(setup)
})
