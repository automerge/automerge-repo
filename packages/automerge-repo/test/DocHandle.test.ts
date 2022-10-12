import assert from "assert"
import { DocHandle, DocumentId } from "../src/DocHandle"

describe("DocHandle", () => {
  it("should take the UUID passed into it", () => {
    const handle = new DocHandle("test-document-id" as DocumentId)
    assert(handle.documentId === "test-document-id")
  })

  it.only("should emit a change message when changes happen", (done) => {
    const handle = new DocHandle<any>("test-document-id" as DocumentId)
    handle.on("change", ({ handle }) => {
      assert(handle.doc.foo === "bar")
      done()
    })
    handle.change((doc) => {
      doc.foo = "bar"
    })
  })
})
