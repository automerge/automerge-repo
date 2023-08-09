import assert from "assert"
import * as CBOR from "cbor-x"
import { EphemeralData } from "../src/EphemeralData.js"
import { ChannelId, PeerId } from "../src/types.js"

describe("EphemeralData", () => {
  const ephemeral = new EphemeralData()
  const otherPeerId = "other_peer" as PeerId
  const destinationChannelId = "channel_id" as ChannelId
  const messageData = { foo: "bar" }

  it("should emit a network message on broadcast()", done => {
    ephemeral.on("message", message => {
      try {
        assert.deepStrictEqual(CBOR.decode(message.data), messageData)
        assert.strictEqual(message.type, "broadcast")
        assert.strictEqual(message.channelId, destinationChannelId)
        done()
      } catch (e) {
        done(e)
      }
    })
    ephemeral.broadcast(destinationChannelId, messageData)
  })

  it("should emit a data event on receive()", done => {
    ephemeral.on("data", ({ peerId, channelId, data }) => {
      try {
        assert.deepStrictEqual(peerId, otherPeerId)
        assert.deepStrictEqual(channelId, destinationChannelId)
        assert.deepStrictEqual(data, messageData)
        done()
      } catch (e) {
        done(e)
      }
    })
    ephemeral.receive({
      senderId: otherPeerId,
      channelId: destinationChannelId,
      data: CBOR.encode(messageData),
      type: "broadcast",
      count: 0,
      sessionId: ephemeral.sessionId,
    })
  })
})
