import assert from "assert"
import * as CBOR from "cbor-x"
import { EphemeralData } from "../src/EphemeralData.js"
import { DocumentId, PeerId } from "../src/types.js"

describe("EphemeralData", () => {
  const bob = "bob" as PeerId
  const ephemeral = new EphemeralData()
  const testDocumentId = "test_document_id" as DocumentId
  const testPayload = { foo: "bar" }

  it("should emit a network message on broadcast()", done => {
    ephemeral.on("message", ({ documentId, payload }) => {
      assert.deepStrictEqual(CBOR.decode(payload), testPayload)
      assert.strictEqual(documentId, documentId)
      done()
    })
    ephemeral.broadcast(testDocumentId, testPayload)
  })

  it("should emit a data event on receive()", done => {
    ephemeral.on("data", ({ senderId, documentId, payload }) => {
      assert.deepStrictEqual(senderId, bob)
      assert.deepStrictEqual(documentId, testDocumentId)
      assert.deepStrictEqual(payload, testPayload)
      done()
    })

    ephemeral.receive({
      type: "EPHEMERAL",
      senderId: bob,
      documentId: testDocumentId,
      payload: CBOR.encode(testPayload),
    })
  })
})
