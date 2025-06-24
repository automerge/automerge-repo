import { assert, describe, it } from "vitest"
import { runNetworkAdapterTests } from "../../automerge-repo/src/helpers/tests/network-adapter-tests.js"
import {
  MessageChannelNetworkAdapter as Adapter,
  MessageChannelNetworkAdapter,
} from "../src/index.js"
import { Repo } from "@automerge/automerge-repo/slim"

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

  it("should close the network adapter when a 'leave' message is received", async () => {
    const { port1: aliceToBob, port2: bobToAlice } = new MessageChannel()
    const alice = new Repo({
      network: [
        new MessageChannelNetworkAdapter(aliceToBob, { useWeakRef: false }),
      ],
    })
    const bob = new Repo({
      network: [
        new MessageChannelNetworkAdapter(bobToAlice, { useWeakRef: true }),
      ],
    })

    await Promise.all([
      alice.networkSubsystem.whenReady(),
      bob.networkSubsystem.whenReady(),
    ])

    alice.networkSubsystem.disconnect()

    // Wait for bob to process the leave message
    await new Promise(r => setTimeout(r, 100))

    assert.equal(bob.networkSubsystem.adapters.length, 0)
    assert.equal(alice.networkSubsystem.adapters.length, 0)
  })
})
