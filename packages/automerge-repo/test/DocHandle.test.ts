import * as Automerge from "@automerge/automerge"
import assert from "assert"
import { DocHandle, DocumentId } from "../src"
import { eventPromise } from "../src/helpers/eventPromise"

interface TestDoc {
  foo: string
}

describe("DocHandle", () => {
  it("should take the UUID passed into it", () => {
    const handle = new DocHandle("test-document-id" as DocumentId)
    assert(handle.documentId === "test-document-id")
  })

  it("should not be ready until updateDoc is called", () => {
    const handle = new DocHandle<TestDoc>("test-document-id" as DocumentId)
    assert(handle.ready() === false)
    // updateDoc is called by the sync / storage systems
    // this call is just to simulate loading
    handle.updateDoc(doc => Automerge.change(doc, d => (d.foo = "bar")))
    assert(handle.ready() === true)
  })

  it("should not return a value until ready()", async () => {
    const handle = new DocHandle<TestDoc>("test-document-id" as DocumentId)
    assert(handle.ready() === false)
    let tooSoon = true as boolean

    handle.updateDoc(doc => {
      tooSoon = false
      return Automerge.change(doc, d => (d.foo = "bar"))
    })

    const doc = await handle.value()

    assert(tooSoon === false)
    assert(handle.ready() === true)
    assert(doc.foo === "bar")
  })
})

it("should return syncValue following an incremental load on an existing document", async () => {
  const handle = new DocHandle<TestDoc>("test-document-id" as DocumentId)
  assert(handle.ready() === false)

  handle.loadIncremental(
    Automerge.save(
      Automerge.change<{ foo: string }>(Automerge.init(), d => (d.foo = "bar"))
    )
  )

  const doc = await handle.syncValue()
  assert(handle.ready() === true)
  assert(doc.foo === "bar")
})

it("should block changes until ready()", done => {
  const handle = new DocHandle<TestDoc>("test-document-id" as DocumentId)
  assert(handle.ready() === false)
  let tooSoon = true
  handle.updateDoc(doc => {
    tooSoon = false
    return Automerge.change(doc, d => (d.foo = "bar"))
  })
  handle.change(() => {
    try {
      assert(tooSoon === false)
      assert(handle.ready() === true)
      done()
    } catch (e) {
      done(e)
    }
  })
})

it("should emit a change message when changes happen", async () => {
  const handle = new DocHandle<TestDoc>("test-document-id" as DocumentId, true)
  handle.change(doc => {
    doc.foo = "bar"
  })

  await eventPromise(handle, "change")
  assert(handle.doc.foo === "bar")
})

it("should not emit a change message if no change happens via updateDoc", done => {
  const handle = new DocHandle<TestDoc>("test-document-id" as DocumentId, true)
  handle.on("change", () => {
    done(new Error("shouldn't have changed"))
  })
  handle.updateDoc(d => {
    setTimeout(done, 0)
    return d
  })
})

it("should emit a patch message when changes happen", async () => {
  const handle = new DocHandle<TestDoc>("test-document-id" as DocumentId, true)
  handle.change(doc => {
    doc.foo = "bar"
  })

  const { after } = await eventPromise(handle, "patch")
  assert(after.foo === "bar")
})

it("should not emit a patch message if no change happens", done => {
  const handle = new DocHandle<TestDoc>("test-document-id" as DocumentId, true)
  handle.on("patch", () => {
    done(new Error("shouldn't have patched"))
  })
  handle.change(_doc => {
    // do nothing
    setTimeout(done, 0)
  })
})
