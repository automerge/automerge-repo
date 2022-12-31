import { expect } from "chai"
import { ChannelId, PeerId } from "automerge-repo"
import { MessageChannelNetworkAdapter } from "../src"

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
})

function stringToBytes(str: string): Uint8Array {
  const encoder = new TextEncoder()
  return encoder.encode(str)
}
