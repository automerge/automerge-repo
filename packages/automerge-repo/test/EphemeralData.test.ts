import assert from "assert"
import * as CBOR from "cbor-x"
import { EphemeralData } from "../src/EphemeralData"
import { ChannelId, PeerId } from "../src/types"

describe("EphemeralData", () => {
  const eD = new EphemeralData()
  const otherPeerId = "other_peer" as PeerId
  const destinationChannelId = "channel_id" as ChannelId
  const messageData = { foo: "bar" }

  it("should emit a network message on broadcast()", done => {
    eD.on("message", event => {
      try {
        const { targetId, channelId, message, broadcast } = event
        assert.deepStrictEqual(CBOR.decode(message), messageData)
        assert.strictEqual(broadcast, true)
        assert.strictEqual(channelId, channelId)
        done()
      } catch (e) {
        done(e)
      }
    })
    eD.broadcast(destinationChannelId, messageData)
  })

  it("should emit a data event on receive()", done => {
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
    eD.receive(
      otherPeerId,
      ("m/" + destinationChannelId) as ChannelId, // TODO: this is nonsense
      CBOR.encode(messageData)
    )
  })
})
