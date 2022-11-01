import assert from "assert"
import * as CBOR from "cbor-x"
import { EphemeralData } from "../src/EphemeralData"
import { ChannelId, PeerId } from "../src/network/NetworkSubsystem"

describe("EphemeralData", () => {
  const eD = new EphemeralData()
  const otherPeerId = "other_peer" as PeerId
  const destinationChannelId = "channel_id" as ChannelId
  const messageData = { foo: "bar" }

  it("should emit a network message on broadcast()", (done) => {
    eD.on("message", (event) => {
      try {
        const { peerId, channelId, message } = event
        assert.deepStrictEqual(CBOR.decode(message), messageData)
        assert.strictEqual(peerId, "*")
        assert.strictEqual(channelId, channelId)
        done()
      } catch (e) {
        done(e)
      }
    })
    eD.broadcast(destinationChannelId, messageData)
  })

  it("should emit a data event on receiveBroadcast()", (done) => {
    eD.on("data", ({ peerId, channelId, data }) => {
      try {
        assert.deepStrictEqual(peerId, otherPeerId)
        assert.deepStrictEqual(channelId, destinationChannelId)
        assert.deepStrictEqual(data, messageData)
        done()
      } catch (e) {
        done(e)
      }
    })
    eD.receiveBroadcast(
      otherPeerId,
      destinationChannelId,
      CBOR.encode(messageData)
    )

    const v = eD.value(destinationChannelId)
    assert.deepEqual(v![otherPeerId], messageData)
  })
})
