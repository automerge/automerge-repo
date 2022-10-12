import assert from "assert"
import { DocHandle, DocumentId } from "../src/DocHandle"
import * as Automerge from "@automerge/automerge"

describe("DocHandle", () => {
  it("should take the UUID passed into it", () => {
    const handle = new DocHandle("test-document-id" as DocumentId)
    assert(handle.documentId === "test-document-id")
  })

  it("should not be ready until updateDoc is called", () => {
    const handle = new DocHandle("test-document-id" as DocumentId)
    assert(handle.ready() === false)
    // updateDoc is called by the sync / storage systems
    // this call is just to simulate loading
    handle.updateDoc((doc) =>
      Automerge.change(doc, (d: any) => (d.foo = "bar"))
    )
    assert(handle.ready() === true)
  })

  it("should not return a value until ready()", (done) => {
    const handle = new DocHandle("test-document-id" as DocumentId)
    assert(handle.ready() === false)
    let tooSoon = true
    handle.updateDoc((doc) => {
      tooSoon = false
      return Automerge.change(doc, (d: any) => (d.foo = "bar"))
    })
    handle.value().then((doc) => {
      try {
        assert(tooSoon === false)
        assert(handle.ready() === true)
        done()
      } catch (e) {
        done(e)
      }
    })
  })

  it("should block changes until ready()", (done) => {
    const handle = new DocHandle("test-document-id" as DocumentId)
    assert(handle.ready() === false)
    let tooSoon = true
    handle.updateDoc((doc) => {
      tooSoon = false
      return Automerge.change(doc, (d: any) => (d.foo = "bar"))
    })
    handle.change((doc) => {
      try {
        assert(tooSoon === false)
        assert(handle.ready() === true)
        done()
      } catch (e) {
        done(e)
      }
    })
  })

  it("should emit a change message when changes happen", (done) => {
    const handle = new DocHandle<any>("test-document-id" as DocumentId, true)
    handle.on("change", ({ handle }) => {
      assert(handle.doc.foo === "bar")
      done()
    })
    handle.change((doc) => {
      doc.foo = "bar"
    })
  })

  it("should emit a patch message when changes happen", (done) => {
    const handle = new DocHandle<any>("test-document-id" as DocumentId, true)
    handle.on("patch", ({ handle, patch, after }) => {
      console.log(patch)
      assert.deepEqual(patch, {
        action: "put",
        path: ["foo"],
        value: "bar",
        conflict: false,
      })

      assert(after.foo === "bar", "after message didn't match")
      done()
    })
    handle.change((doc) => {
      doc.foo = "bar"
    })
  })

  it("should not emit a patch message if no change happens", (done) => {
    const handle = new DocHandle<any>("test-document-id" as DocumentId, true)
    handle.on("patch", () => {
      done(new Error("shouldn't have patched"))
    })
    handle.change((doc) => {
      // do nothing
      setTimeout(done, 0)
    })
  })
})
