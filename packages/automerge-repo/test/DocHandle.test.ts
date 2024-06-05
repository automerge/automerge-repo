import * as A from "@automerge/automerge/next"
import assert from "assert"
import { decode } from "cbor-x"
import { describe, it, vi } from "vitest"
import { generateAutomergeUrl, parseAutomergeUrl } from "../src/AutomergeUrl.js"
import { eventPromise } from "../src/helpers/eventPromise.js"
import { pause } from "../src/helpers/pause.js"
import { DocHandle, DocHandleChangePayload } from "../src/index.js"
import { TestDoc } from "./types.js"

describe("DocHandle", () => {
  const TEST_ID = parseAutomergeUrl(generateAutomergeUrl()).documentId

  const docFromMockStorage = (doc: A.Doc<{ foo: string }>) => {
    return A.change<{ foo: string }>(doc, d => (d.foo = "bar"))
  }

  it("should take the UUID passed into it", () => {
    const handle = new DocHandle(TEST_ID)
    assert.equal(handle.documentId, TEST_ID)
  })

  it("should take an initial value", async () => {
    const handle = new DocHandle(TEST_ID, {
      isNew: true,
      initialValue: { foo: "bar" },
    })
    const doc = await handle.doc()
    assert.equal(doc.foo, "bar")
  })

  it("should become ready when a document is loaded", async () => {
    const handle = new DocHandle<TestDoc>(TEST_ID)
    assert.equal(handle.isReady(), false)

    // simulate loading from storage
    handle.update(doc => docFromMockStorage(doc))

    assert.equal(handle.isReady(), true)
    const doc = await handle.doc()
    assert.equal(doc?.foo, "bar")
  })

  it("should allow sync access to the doc", async () => {
    const handle = new DocHandle<TestDoc>(TEST_ID)
    assert.equal(handle.isReady(), false)

    // simulate loading from storage
    handle.update(doc => docFromMockStorage(doc))

    assert.equal(handle.isReady(), true)
    const doc = await handle.doc()
    assert.deepEqual(doc, handle.docSync())
  })

  it("should return undefined if we access the doc before ready", async () => {
    const handle = new DocHandle<TestDoc>(TEST_ID)

    assert.equal(handle.docSync(), undefined)
  })

  it("should not return a doc until ready", async () => {
    const handle = new DocHandle<TestDoc>(TEST_ID)
    assert.equal(handle.isReady(), false)

    // simulate loading from storage
    handle.update(doc => docFromMockStorage(doc))

    const doc = await handle.doc()

    assert.equal(handle.isReady(), true)
    assert.equal(doc?.foo, "bar")
  })

  it("should return the heads when requested", async () => {
    const handle = new DocHandle<TestDoc>(TEST_ID, {
      isNew: true,
      initialValue: { foo: "bar" },
    })
    assert.equal(handle.isReady(), true)

    const heads = A.getHeads(handle.docSync())
    assert.notDeepEqual(handle.heads(), [])
    assert.deepEqual(heads, handle.heads())
  })

  it("should return undefined if the heads aren't loaded", async () => {
    const handle = new DocHandle<TestDoc>(TEST_ID)
    assert.equal(handle.isReady(), false)
    assert.deepEqual(handle.heads(), undefined)
  })

  /**
   * Once there's a Repo#stop API this case should be covered in accompanying
   * tests and the following test removed.
   */
  it("no pending timers after a document is loaded", async () => {
    vi.useFakeTimers()
    const timerCount = vi.getTimerCount()

    const handle = new DocHandle<TestDoc>(TEST_ID)
    assert.equal(handle.isReady(), false)

    handle.doc()

    assert(vi.getTimerCount() > timerCount)

    // simulate loading from storage
    handle.update(doc => docFromMockStorage(doc))

    assert.equal(handle.isReady(), true)
    assert.equal(vi.getTimerCount(), timerCount)
    vi.useRealTimers()
  })

  it("should block changes until ready()", async () => {
    const handle = new DocHandle<TestDoc>(TEST_ID)

    // can't make changes in LOADING state
    assert.equal(handle.isReady(), false)
    assert.throws(() => handle.change(d => (d.foo = "baz")))

    // simulate loading from storage
    handle.update(doc => docFromMockStorage(doc))

    // now we're in READY state so we can make changes
    assert.equal(handle.isReady(), true)
    handle.change(d => (d.foo = "pizza"))

    const doc = await handle.doc()
    assert.equal(doc?.foo, "pizza")
  })

  it("should not be ready while requesting from the network", async () => {
    const handle = new DocHandle<TestDoc>(TEST_ID)

    // we don't have it in storage, so we request it from the network
    handle.request()

    assert.equal(handle.docSync(), undefined)
    assert.equal(handle.isReady(), false)
    assert.throws(() => handle.change(_ => {}))
  })

  it("should become ready if the document is updated by the network", async () => {
    const handle = new DocHandle<TestDoc>(TEST_ID)

    // we don't have it in storage, so we request it from the network
    handle.request()

    // simulate updating from the network
    handle.update(doc => {
      return A.change(doc, d => (d.foo = "bar"))
    })

    const doc = await handle.doc()
    assert.equal(handle.isReady(), true)
    assert.equal(doc?.foo, "bar")
  })

  it("should emit a change message when changes happen", async () => {
    const handle = new DocHandle<TestDoc>(TEST_ID, { isNew: true })

    const p = new Promise<DocHandleChangePayload<TestDoc>>(resolve =>
      handle.once("change", d => resolve(d))
    )

    handle.change(doc => {
      doc.foo = "bar"
    })

    const doc = await handle.doc()
    assert.equal(doc?.foo, "bar")

    const changePayload = await p
    assert.deepStrictEqual(changePayload.doc, doc)
    assert.deepStrictEqual(changePayload.handle, handle)
  })

  it("should not emit a change message if no change happens via update", () =>
    new Promise<void>((done, reject) => {
      const handle = new DocHandle<TestDoc>(TEST_ID, { isNew: true })
      handle.once("change", () => {
        reject(new Error("shouldn't have changed"))
      })
      handle.update(d => {
        setTimeout(done, 0)
        return d
      })
    }))

  it("should update the internal doc prior to emitting the change message", async () => {
    const handle = new DocHandle<TestDoc>(TEST_ID, { isNew: true })

    const p = new Promise<void>(resolve =>
      handle.once("change", ({ handle, doc }) => {
        assert.equal(handle.docSync()?.foo, doc.foo)

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

    const doc = await handle.doc()
    assert.equal(doc?.foo, "baz")

    return p
  })

  it("should emit a change message when changes happen", async () => {
    const handle = new DocHandle<TestDoc>(TEST_ID, { isNew: true })
    const p = new Promise(resolve => handle.once("change", d => resolve(d)))

    handle.change(doc => {
      doc.foo = "bar"
    })

    await p
    const doc = await handle.doc()
    assert.equal(doc?.foo, "bar")
  })

  it("should not emit a patch message if no change happens", () =>
    new Promise<void>((done, reject) => {
      const handle = new DocHandle<TestDoc>(TEST_ID, { isNew: true })
      handle.on("change", () => {
        reject(new Error("shouldn't have changed"))
      })
      handle.change(_doc => {
        // do nothing
        setTimeout(done, 0)
      })
    }))

  it("should be undefined if loading the document times out", async () => {
    // set docHandle time out after 5 ms
    const handle = new DocHandle<TestDoc>(TEST_ID, { timeoutDelay: 5 })

    const doc = await handle.doc()

    assert.equal(doc, undefined)

    assert.equal(handle.state, "unavailable")
  })

  it("should not time out if the document is loaded in time", async () => {
    // set docHandle time out after 5 ms
    const handle = new DocHandle<TestDoc>(TEST_ID, { timeoutDelay: 5 })

    // simulate loading from storage before the timeout expires
    handle.update(doc => docFromMockStorage(doc))

    // now it should not time out
    const doc = await handle.doc()
    assert.equal(doc?.foo, "bar")
  })

  it("should be undefined if loading from the network times out", async () => {
    // set docHandle time out after 5 ms
    const handle = new DocHandle<TestDoc>(TEST_ID, { timeoutDelay: 5 })

    // simulate requesting from the network
    handle.request()

    // there's no update
    await pause(10)

    const doc = await handle.doc()
    assert.equal(doc, undefined)
  })

  it("should not time out if the document is updated in time", async () => {
    // set docHandle time out after 5 ms
    const handle = new DocHandle<TestDoc>(TEST_ID, { timeoutDelay: 1 })

    // simulate requesting from the network
    handle.request()

    // simulate updating from the network before the timeout expires
    handle.update(doc => {
      return A.change(doc, d => (d.foo = "bar"))
    })

    // now it should not time out
    await pause(5)

    const doc = await handle.doc()
    assert.equal(doc?.foo, "bar")
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

  it("should allow changing at old heads", async () => {
    const handle = new DocHandle<TestDoc>(TEST_ID, { isNew: true })

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

  describe("ephemeral messaging", () => {
    it("can broadcast a message for the network to send out", async () => {
      const handle = new DocHandle<TestDoc>(TEST_ID, { isNew: true })
      const message = { foo: "bar" }

      const promise = eventPromise(handle, "ephemeral-message-outbound")

      handle.broadcast(message)

      const { data } = await promise
      assert.deepStrictEqual(decode(data), message)
    })
  })
})
