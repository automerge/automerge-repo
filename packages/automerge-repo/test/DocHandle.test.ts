import * as A from "@automerge/automerge"
import assert from "assert"
import { it } from "mocha"
import { DocHandle, DocHandleChangePayload, DocumentId } from "../src"
import { pause } from "../src/helpers/pause"
import { TestDoc } from "./types.js"

describe("DocHandle", () => {
  const TEST_ID = "test-document-id" as DocumentId

  const binaryFromMockStorage = () => {
    const doc = A.change<{ foo: string }>(A.init(), d => (d.foo = "bar"))
    const binary = A.save(doc)
    return binary
  }

  it("should take the UUID passed into it", () => {
    const handle = new DocHandle(TEST_ID)
    assert.equal(handle.documentId, TEST_ID)
  })

  it("should become ready when a document is loaded", async () => {
    const handle = new DocHandle<TestDoc>(TEST_ID)
    assert.equal(handle.isReady(), false)

    // simulate loading from storage
    handle.load(binaryFromMockStorage())

    assert.equal(handle.isReady(), true)
    const doc = await handle.value()
    assert.equal(doc.foo, "bar")
  })

  it("should allow sync access to the doc", async () => {
    const handle = new DocHandle<TestDoc>(TEST_ID)
    assert.equal(handle.isReady(), false)

    // simulate loading from storage
    handle.load(binaryFromMockStorage())

    assert.equal(handle.isReady(), true)
    const doc = await handle.value()
    assert.deepEqual(doc, handle.doc)
  })

  it("should throws an error if we accessing the doc before ready", async () => {
    const handle = new DocHandle<TestDoc>(TEST_ID)

    assert.throws(() => handle.doc)
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

  it("should block changes until ready()", async () => {
    const handle = new DocHandle<TestDoc>(TEST_ID)

    // can't make changes in LOADING state
    assert.equal(handle.isReady(), false)
    assert.throws(() => handle.change(d => (d.foo = "baz")))

    // simulate loading from storage
    handle.load(binaryFromMockStorage())

    // now we're in READY state so we can make changes
    assert.equal(handle.isReady(), true)
    handle.change(d => (d.foo = "pizza"))

    const doc = await handle.value()
    assert.equal(doc.foo, "pizza")
  })

  it("should not be ready while requesting from the network", async () => {
    const handle = new DocHandle<TestDoc>(TEST_ID)

    // we don't have it in storage, so we request it from the network
    handle.request()

    assert.throws(() => handle.doc)
    assert.equal(handle.isReady(), false)
    assert.throws(() => handle.change(h => {}))
  })

  it("should become ready if the document is updated by the network", async () => {
    const handle = new DocHandle<TestDoc>(TEST_ID)

    // we don't have it in storage, so we request it from the network
    handle.request()

    // simulate updating from the network
    handle.update(doc => {
      return A.change(doc, d => (d.foo = "bar"))
    })

    const doc = await handle.value()
    assert.equal(handle.isReady(), true)
    assert.equal(doc.foo, "bar")
  })

  it("should emit a change message when changes happen", async () => {
    const handle = new DocHandle<TestDoc>(TEST_ID, { isNew: true })

    const p = new Promise<DocHandleChangePayload<TestDoc>>(resolve =>
      handle.once("change", d => resolve(d))
    )

    handle.change(doc => {
      doc.foo = "bar"
    })

    const doc = await handle.value()
    assert.equal(doc.foo, "bar")

    const changePayload = await p
    assert.deepStrictEqual(changePayload.doc, doc)
    assert.deepStrictEqual(changePayload.handle, handle)
  })

  it("should not emit a change message if no change happens via update", done => {
    const handle = new DocHandle<TestDoc>(TEST_ID, { isNew: true })
    handle.once("change", () => {
      done(new Error("shouldn't have changed"))
    })
    handle.update(d => {
      setTimeout(done, 0)
      return d
    })
  })

  it("should update the internal doc prior to emitting the change message", async () => {
    const handle = new DocHandle<TestDoc>(TEST_ID, { isNew: true })

    const p = new Promise<void>(resolve =>
      handle.once("change", ({ handle, doc }) => {
        assert.equal(handle.doc.foo, doc.foo)

        resolve()
      })
    )

    handle.change(doc => {
      doc.foo = "baz"
    })

    return p
  })

  it("should emit distinct change messages when consecutive changes happen", async () => {
    const handle = new DocHandle<TestDoc>(TEST_ID, { isNew: true })

    let calls = 0
    const p = new Promise(resolve =>
      handle.on("change", async ({ doc: d }) => {
        if (calls === 0) {
          assert.equal(d.foo, "bar")
          calls++
          return
        }
        assert.equal(d.foo, "baz")
        resolve(d)
      })
    )

    handle.change(doc => {
      doc.foo = "bar"
    })

    handle.change(doc => {
      doc.foo = "baz"
    })

    const doc = await handle.value()
    assert.equal(doc.foo, "baz")

    return p
  })

  it("should emit a patch message when changes happen", async () => {
    const handle = new DocHandle<TestDoc>(TEST_ID, { isNew: true })
    const p = new Promise(resolve => handle.once("patch", d => resolve(d)))

    handle.change(doc => {
      doc.foo = "bar"
    })

    await p
    const doc = await handle.value()
    assert.equal(doc.foo, "bar")
  })

  it("should not emit a patch message if no change happens", done => {
    const handle = new DocHandle<TestDoc>(TEST_ID, { isNew: true })
    handle.on("patch", () => {
      done(new Error("shouldn't have patched"))
    })
    handle.change(_doc => {
      // do nothing
      setTimeout(done, 0)
    })
  })

  it("should time out if the document is not loaded", async () => {
    // set docHandle time out after 5 ms
    const handle = new DocHandle<TestDoc>(TEST_ID, { timeoutDelay: 5 })

    // we're not going to load
    await pause(10)

    // so it should time out
    return assert.rejects(handle.value, "DocHandle timed out")
  })

  it("should not time out if the document is loaded in time", async () => {
    // set docHandle time out after 5 ms
    const handle = new DocHandle<TestDoc>(TEST_ID, { timeoutDelay: 5 })

    // simulate loading from storage before the timeout expires
    handle.load(binaryFromMockStorage())

    // now it should not time out
    const doc = await handle.value()
    assert.equal(doc.foo, "bar")
  })

  it("should time out if the document is not updated from the network", async () => {
    // set docHandle time out after 5 ms
    const handle = new DocHandle<TestDoc>(TEST_ID, { timeoutDelay: 5 })

    // simulate requesting from the network
    handle.request()

    // there's no update
    await pause(10)

    // so it should time out
    return assert.rejects(handle.value, "DocHandle timed out")
  })

  it("should not time out if the document is updated in time", async () => {
    // set docHandle time out after 5 ms
    const handle = new DocHandle<TestDoc>(TEST_ID, { timeoutDelay: 5 })

    // simulate requesting from the network
    handle.request()

    // simulate updating from the network before the timeout expires
    handle.update(doc => {
      return A.change(doc, d => (d.foo = "bar"))
    })

    // now it should not time out
    const doc = await handle.value()
    assert.equal(doc.foo, "bar")
  })

  it("should emit a delete event when deleted", async () => {
    const handle = new DocHandle<TestDoc>(TEST_ID, { isNew: true })

    const p = new Promise<void>(resolve =>
      handle.once("delete", () => resolve())
    )
    handle.delete()
    await p

    assert.equal(handle.isDeleted(), true)
  })
})
