import { describe } from "vitest"
import { runNetworkAdapterTests } from "../../automerge-repo/src/helpers/tests/network-adapter-tests.js"
import { MessageChannelNetworkAdapter as Adapter } from "../src/index.js"

// bob is the hub, alice and charlie are spokes
describe("MessageChannelNetworkAdapter", () => {
  runNetworkAdapterTests(async () => {
    const aliceBobChannel = new MessageChannel()
    const bobCharlieChannel = new MessageChannel()

    const { port1: aliceToBob, port2: bobToAlice } = aliceBobChannel
    const { port1: bobToCharlie, port2: charlieToBob } = bobCharlieChannel

    const a = new Adapter(aliceToBob)
    const b = [new Adapter(bobToAlice), new Adapter(bobToCharlie)]
    const c = new Adapter(charlieToBob)

    const teardown = () => {
      const ports = [aliceToBob, bobToAlice, bobToCharlie, charlieToBob]
      ports.forEach(port => port.close())
    }

    return { adapters: [a, b, c], teardown }
  }, "hub and spoke")

  // all 3 peers connected directly to each other
  runNetworkAdapterTests(async () => {
    const aliceBobChannel = new MessageChannel()
    const bobCharlieChannel = new MessageChannel()
    const aliceCharlieChannel = new MessageChannel()

    const { port1: aliceToBob, port2: bobToAlice } = aliceBobChannel
    const { port1: bobToCharlie, port2: charlieToBob } = bobCharlieChannel
    const { port1: aliceToCharlie, port2: charlieToAlice } = aliceCharlieChannel

    const a = [new Adapter(aliceToBob), new Adapter(aliceToCharlie)]
    const b = [new Adapter(bobToAlice), new Adapter(bobToCharlie)]
    const c = [new Adapter(charlieToBob), new Adapter(charlieToAlice)]

    const teardown = () => {
      const ports = [
        aliceToBob,
        bobToAlice,
        bobToCharlie,
        charlieToBob,
        aliceToCharlie,
        charlieToAlice,
      ]
      ports.forEach(port => port.close())
    }

    return { adapters: [a, b, c], teardown }
  }, "all-to-all")
})
