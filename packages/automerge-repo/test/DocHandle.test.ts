import * as Automerge from "@automerge/automerge"
import assert from "assert"
import { DocHandle, DocumentId } from "../src"
import { eventPromise } from "../src/helpers/eventPromise.js"
import { TestDoc } from "./types.js"

describe("DocHandle", () => {
  const TEST_ID = "test-document-id" as DocumentId

  const binaryFromMockStorage = () => {
    const doc = Automerge.change<{ foo: string }>(
      Automerge.init(),
      d => (d.foo = "bar")
    )
    const binary = Automerge.save(doc)
    return binary
  }

  it("should take the UUID passed into it", () => {
    const handle = new DocHandle(TEST_ID)
    assert.equal(handle.documentId, TEST_ID)
  })

  it("should not be ready until document is loaded", () => {
    const handle = new DocHandle<TestDoc>(TEST_ID)
    assert.equal(handle.isReady(), false)

    // simulate loading from storage
    handle.load(binaryFromMockStorage())

    assert.equal(handle.isReady(), true)
  })

  it("should not return a value until ready", async () => {
    const handle = new DocHandle<TestDoc>(TEST_ID)
    assert.equal(handle.isReady(), false)

    // simulate loading from storage
    handle.load(binaryFromMockStorage())

    const doc = await handle.value()

    assert.equal(handle.isReady(), true)
    assert.equal(doc.foo, "bar")
  })

  it("should return provisionalValue following an incremental load on an existing document", async () => {
    const handle = new DocHandle<TestDoc>(TEST_ID)
    assert.equal(handle.isReady(), false)

    handle.load(binaryFromMockStorage())

    const provisionalDoc = await handle.provisionalValue()
    assert.equal(handle.isReady(), true)
    assert.equal(provisionalDoc.foo, "bar")
  })

  it("should block changes until ready()", done => {
    const handle = new DocHandle<TestDoc>(TEST_ID)
    assert.equal(handle.isReady(), false)
    let tooSoon = true
    handle.update(doc => {
      tooSoon = false
      return Automerge.change(doc, d => (d.foo = "bar"))
    })
    handle.change(() => {
      try {
        assert.equal(tooSoon, false)
        assert.equal(handle.isReady(), true)
        done()
      } catch (e) {
        done(e)
      }
    })
  })

  it("should emit a change message when changes happen", async () => {
    const handle = new DocHandle<TestDoc>(TEST_ID, true)
    handle.change(doc => {
      doc.foo = "bar"
    })

    await eventPromise(handle, "change")
    assert.equal(handle.doc.foo, "bar")
  })

  it("should not emit a change message if no change happens via update", done => {
    const handle = new DocHandle<TestDoc>(TEST_ID, true)
    handle.on("change", () => {
      done(new Error("shouldn't have changed"))
    })
    handle.update(d => {
      setTimeout(done, 0)
      return d
    })
  })

  it("should emit a patch message when changes happen", async () => {
    const handle = new DocHandle<TestDoc>(TEST_ID, true)
    handle.change(doc => {
      doc.foo = "bar"
    })

    const { after } = await eventPromise(handle, "patch")
    assert.equal(after.foo, "bar")
  })

  it("should not emit a patch message if no change happens", done => {
    const handle = new DocHandle<TestDoc>(TEST_ID, true)
    handle.on("patch", () => {
      done(new Error("shouldn't have patched"))
    })
    handle.change(_doc => {
      // do nothing
      setTimeout(done, 0)
    })
  })
})
