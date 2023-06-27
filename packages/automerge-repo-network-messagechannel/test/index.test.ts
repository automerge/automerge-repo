import { assert, expect } from "chai"
import { ChannelId, PeerId, Repo } from "@automerge/automerge-repo"
import { MessageChannelNetworkAdapter } from "../src"
import { eventPromise } from "@automerge/automerge-repo/src/helpers/eventPromise"
import { pause } from "@automerge/automerge-repo/src/helpers/pause"

describe("MessageChannel", () => {
  it("sends message", async () => {
    const messageChannel = new MessageChannel()

    const alicePort = messageChannel.port1
    const bobPort = messageChannel.port2

    const aliceAdapter = new MessageChannelNetworkAdapter(alicePort)

    const alice = "alice" as PeerId
    const bob = "bob" as PeerId
    const channel = "channel" as ChannelId

    const message = stringToBytes("hello")

    bobPort.onmessage = ({ data }) => {
      expect(data.message).to.equal(message)
    }

    aliceAdapter.connect(alice)
    aliceAdapter.sendMessage(bob, channel, message, false)
    alicePort.close()
    bobPort.close()
  })

  it("can sync a document from one repo to another", async () => {
    const aliceBobChannel = new MessageChannel()

    const { port1: aliceToCharlie, port2: charlieToAlice } = aliceBobChannel

    const aliceRepo = new Repo({
      network: [new MessageChannelNetworkAdapter(aliceToCharlie)],
      peerId: "alice" as PeerId,
    })

    const charlieRepo = new Repo({
      network: [new MessageChannelNetworkAdapter(charlieToAlice)],
      peerId: "charlie" as PeerId,
    })

    const p = eventPromise(charlieRepo, "document")

    const handle = aliceRepo.create<{ foo: string }>()
    handle.change(d => {
      d.foo = "bar"
    })

    await p

    const charlieHandle = charlieRepo.find<{ foo: string }>(handle.documentId)
    await eventPromise(charlieHandle, "change")
    const v = await charlieHandle.value()

    assert.equal(v.foo, "bar")
  })
})

function stringToBytes(str: string): Uint8Array {
  const encoder = new TextEncoder()
  return encoder.encode(str)
}
