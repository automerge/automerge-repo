import {
  runAdapterTests,
  type SetupFn,
} from "automerge-repo-network-acceptance-tests"
import { MessageChannelNetworkAdapter } from "../src"

describe("MessageChannelNetworkAdapter", () => {
  const setup: SetupFn = async () => {
    const aliceBobChannel = new MessageChannel()
    const { port1: aliceToBob, port2: bobToAlice } = aliceBobChannel

    const a = new MessageChannelNetworkAdapter(aliceToBob)
    const b = new MessageChannelNetworkAdapter(bobToAlice)

    return { adapters: [a, b] }
  }

  runAdapterTests(setup)
})
