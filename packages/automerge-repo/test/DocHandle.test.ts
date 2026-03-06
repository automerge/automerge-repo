import { next as A } from "@automerge/automerge"
import assert from "assert"
import { decode } from "cbor-x"
import { describe, expect, it, vi } from "vitest"
import {
  encodeHeads,
  generateAutomergeUrl,
  parseAutomergeUrl,
} from "../src/AutomergeUrl.js"
import { eventPromise } from "../src/helpers/eventPromise.js"
import { DocHandle, DocHandleChangePayload } from "../src/index.js"
import { TestDoc } from "./types.js"

describe("DocHandle", () => {
  const TEST_ID = parseAutomergeUrl(generateAutomergeUrl()).documentId
  const setup = () => {
    const handle = new DocHandle<TestDoc>(TEST_ID)
    handle.update(() => A.from<TestDoc>({ foo: "" }))
    return handle
  }

  it("should take the UUID passed into it", () => {
    const handle = new DocHandle(TEST_ID)
    assert.equal(handle.documentId, TEST_ID)
  })

  it("should return an empty doc initially", () => {
    const handle = new DocHandle<TestDoc>(TEST_ID)
    const doc = handle.doc()
    assert.deepEqual(doc, {})
  })

  it("should return data after update", () => {
    const handle = new DocHandle<TestDoc>(TEST_ID)
    handle.update(doc => A.change(doc, d => (d.foo = "bar")))
    assert.equal(handle.doc().foo, "bar")
  })

  it("should return the heads when requested", () => {
    const handle = setup()
    handle.change(d => (d.foo = "bar"))

    const heads = encodeHeads(A.getHeads(handle.doc()))
    assert.notDeepEqual(handle.heads(), [])
    assert.deepEqual(heads, handle.heads())
  })

  it("should return empty heads for a fresh handle", () => {
    const handle = new DocHandle<TestDoc>(TEST_ID)
    assert.deepEqual(handle.heads(), [])
  })

  it("should emit a change message when changes happen", async () => {
    const handle = setup()

    const p = new Promise<DocHandleChangePayload<TestDoc>>(resolve =>
      handle.once("change", d => resolve(d))
    )

    handle.change(doc => {
      doc.foo = "bar"
    })

    const doc = handle.doc()
    assert.equal(doc?.foo, "bar")

    const changePayload = await p
    assert.deepStrictEqual(changePayload.doc, doc)
    assert.deepStrictEqual(changePayload.handle, handle)
  })

  it("should not emit a change message if no change happens via update", () =>
    new Promise<void>((done, reject) => {
      const handle = setup()
      handle.once("change", () => {
        reject(new Error("shouldn't have changed"))
      })
      handle.update(d => {
        setTimeout(done, 0)
        return d
      })
    }))

  it("should update the internal doc prior to emitting the change message", async () => {
    const handle = setup()

    const p = new Promise<void>(resolve =>
      handle.once("change", ({ handle, doc }) => {
        assert.equal(handle.doc()?.foo, doc.foo)
        resolve()
      })
    )

    handle.change(doc => {
      doc.foo = "baz"
    })

    return p
  })

  it("should emit distinct change messages when consecutive changes happen", async () => {
    const handle = setup()

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

    const doc = handle.doc()
    assert.equal(doc?.foo, "baz")

    return p
  })

  it("should not emit a patch message if no change happens", () =>
    new Promise<void>((done, reject) => {
      const handle = setup()
      handle.on("change", () => {
        reject(new Error("shouldn't have changed"))
      })
      handle.change(_doc => {
        // do nothing
        setTimeout(done, 0)
      })
    }))

  it("should emit a heads-changed event when data arrives via update", async () => {
    const handle = new DocHandle<TestDoc>(TEST_ID)
    const p = eventPromise(handle, "heads-changed")
    handle.update(doc => A.change(doc, d => (d.foo = "bar")))
    await p
    assert.equal(handle.doc().foo, "bar")
  })

  it("should allow changing at old heads", async () => {
    const handle = setup()

    handle.change(doc => {
      doc.foo = "bar"
    })

    const headsBefore = handle.heads()!

    handle.change(doc => {
      doc.foo = "rab"
    })

    let wasBar = false
    let newHeads = handle.changeAt(headsBefore, doc => {
      wasBar = doc.foo === "bar"
      doc.foo = "baz"
    })
    assert(newHeads && newHeads.length > 0, "should have new heads")

    assert(wasBar, "foo should have been bar as we changed at the old heads")
  })

  it("should merge another handle", () => {
    const handle1 = new DocHandle<TestDoc>(TEST_ID)
    handle1.update(() => A.from<TestDoc>({ foo: "one" }))

    const OTHER_ID = parseAutomergeUrl(generateAutomergeUrl()).documentId
    const handle2 = new DocHandle<TestDoc>(OTHER_ID)
    handle2.update(() => A.from<TestDoc>({ foo: "two" }))

    handle1.merge(handle2)
    // After merge, handle1 should have data from both
    assert.ok(handle1.doc())
  })

  describe("ephemeral messaging", () => {
    it("can broadcast a message for the network to send out", async () => {
      const handle = setup()

      const message = { foo: "bar" }

      const promise = eventPromise(handle, "ephemeral-message-outbound")

      handle.broadcast(message)

      const { data } = await promise
      assert.deepStrictEqual(decode(data), message)
    })
  })

  it("should continue to function after recovering from an exception in change", () => {
    const handle = setup()

    // throw an error in the change handler, but catch it
    let expectedErr = new Error("Argh!")
    let err: Error | null = null
    try {
      handle.change(doc => {
        doc.foo = "bar"
        throw expectedErr
      })
    } catch (e) {
      err = e
    }
    assert.equal(err, expectedErr, "should have thrown the error")

    // Future changes should still work
    handle.change(doc => {
      doc.foo = "baz"
    })
    assert.equal(handle.doc()?.foo, "baz", "should have changed foo to baz")
  })

  it("should continue to function after recovering from an exception in changeAt", () => {
    const handle = setup()
    handle.change(d => (d.foo = "bar"))

    const heads = handle.heads()!
    handle.change(d => (d.foo = "qux"))

    // throw an error in the change handler, but catch it
    let expectedErr = new Error("Argh!")
    let err: Error | null = null
    try {
      handle.changeAt(heads, doc => {
        doc.foo = "bar"
        throw expectedErr
      })
    } catch (e) {
      err = e
    }
    assert.equal(err, expectedErr, "should have thrown the error")

    // Future changes should still work
    const newHeads = handle.changeAt(heads, doc => {
      doc.foo = "baz"
    })
    assert.ok(newHeads, "should have new heads")
    const viewDoc = A.view(handle.doc(), A.getHeads(handle.doc()))
    assert.ok(viewDoc)
  })
})
