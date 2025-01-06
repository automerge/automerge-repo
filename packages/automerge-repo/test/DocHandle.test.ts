import * as A from "@automerge/automerge/next"
import assert from "assert"
import { decode } from "cbor-x"
import { describe, expect, it, vi } from "vitest"
import { generateAutomergeUrl, parseAutomergeUrl } from "../src/AutomergeUrl.js"
import { eventPromise } from "../src/helpers/eventPromise.js"
import { pause } from "../src/helpers/pause.js"
import { DocHandle, DocHandleChangePayload } from "../src/index.js"
import { TestDoc } from "./types.js"
import { UNLOADED } from "../src/DocHandle.js"

describe("DocHandle", () => {
  const TEST_ID = parseAutomergeUrl(generateAutomergeUrl()).documentId
  const setup = (options?) => {
    const handle = new DocHandle<TestDoc>(TEST_ID, options)
    handle.update(() => A.init())
    handle.doneLoading()
    return handle
  }

  const docFromMockStorage = (doc: A.Doc<{ foo: string }>) => {
    return A.change<{ foo: string }>(doc, d => (d.foo = "bar"))
  }

  it("should take the UUID passed into it", () => {
    const handle = new DocHandle(TEST_ID)
    assert.equal(handle.documentId, TEST_ID)
  })

  it("should become ready when a document is loaded", async () => {
    const handle = new DocHandle<TestDoc>(TEST_ID)
    assert.equal(handle.isReady(), false)

    // simulate loading from storage
    handle.update(doc => docFromMockStorage(doc))

    assert.equal(handle.isReady(), true)
    const doc = handle.doc()
    assert.equal(doc?.foo, "bar")
  })

  it("should allow sync access to the doc", async () => {
    const handle = new DocHandle<TestDoc>(TEST_ID)
    assert.equal(handle.isReady(), false)

    // simulate loading from storage
    handle.update(doc => docFromMockStorage(doc))

    assert.equal(handle.isReady(), true)
    const doc = handle.doc()
    assert.deepEqual(doc, handle.doc())
  })

  it("should return undefined if we access the doc before ready", async () => {
    const handle = new DocHandle<TestDoc>(TEST_ID)
    assert.throws(() => handle.doc())
  })

  it("should not return a doc until ready", async () => {
    const handle = new DocHandle<TestDoc>(TEST_ID)
    assert.equal(handle.isReady(), false)

    // simulate loading from storage
    handle.update(doc => docFromMockStorage(doc))

    const doc = handle.doc()

    assert.equal(handle.isReady(), true)
    assert.equal(doc?.foo, "bar")
  })

  /** HISTORY TRAVERSAL
   * This API is relatively alpha-ish but we're already
   * doing things in our own apps that are fairly ambitious
   * by routing around to a lower-level API.
   * This is an attempt to wrap up the existing practice
   * in a slightly more supportable set of APIs but should be
   * considered provisional: expect further improvements.
   */

  it("should return the heads when requested", async () => {
    const handle = setup()
    handle.change(d => (d.foo = "bar"))
    assert.equal(handle.isReady(), true)

    const heads = A.getHeads(handle.doc())
    assert.notDeepEqual(handle.heads(), [])
    assert.deepEqual(heads, handle.heads())
  })

  it("should return undefined if the heads aren't loaded", async () => {
    const handle = new DocHandle<TestDoc>(TEST_ID)
    assert.equal(handle.isReady(), false)
    assert.deepEqual(handle.heads(), undefined)
  })

  it("should return the history when requested", async () => {
    const handle = setup()
    handle.change(d => (d.foo = "bar"))
    handle.change(d => (d.foo = "baz"))
    assert.equal(handle.isReady(), true)

    const history = handle.history()
    assert.deepEqual(handle.history().length, 2)
  })

  it("should return a commit from the history", async () => {
    const handle = setup()
    handle.change(d => (d.foo = "zero"))
    handle.change(d => (d.foo = "one"))
    handle.change(d => (d.foo = "two"))
    handle.change(d => (d.foo = "three"))
    assert.equal(handle.isReady(), true)

    const history = handle.history()
    const view = handle.view(history[1])
    assert.deepEqual(view, { foo: "one" })
  })

  it("should return diffs", async () => {
    const handle = setup()
    handle.change(d => (d.foo = "zero"))
    handle.change(d => (d.foo = "one"))
    handle.change(d => (d.foo = "two"))
    handle.change(d => (d.foo = "three"))
    assert.equal(handle.isReady(), true)

    const history = handle.history()
    const patches = handle.diff(history[1])
    assert.deepEqual(patches, [
      { action: "put", path: ["foo"], value: "" },
      { action: "splice", path: ["foo", 0], value: "one" },
    ])
  })

  it("should support arbitrary diffs too", async () => {
    const handle = setup()
    handle.change(d => (d.foo = "zero"))
    handle.change(d => (d.foo = "one"))
    handle.change(d => (d.foo = "two"))
    handle.change(d => (d.foo = "three"))
    assert.equal(handle.isReady(), true)

    const history = handle.history()
    const patches = handle.diff(history[1], history[3])
    assert.deepEqual(patches, [
      { action: "put", path: ["foo"], value: "" },
      { action: "splice", path: ["foo", 0], value: "three" },
    ])
    const backPatches = handle.diff(history[3], history[1])
    assert.deepEqual(backPatches, [
      { action: "put", path: ["foo"], value: "" },
      { action: "splice", path: ["foo", 0], value: "one" },
    ])
  })

  it("should allow direct access to decoded changes", async () => {
    const handle = setup()
    const time = Date.now()
    handle.change(d => (d.foo = "foo"), { message: "commitMessage" })
    assert.equal(handle.isReady(), true)

    const metadata = handle.metadata()
    assert.deepEqual(metadata.message, "commitMessage")
    // NOTE: I'm not testing time because of https://github.com/automerge/automerge/issues/965
    // but it does round-trip successfully!
  })

  it("should allow direct access to a specific decoded change", async () => {
    const handle = setup()
    const time = Date.now()
    handle.change(d => (d.foo = "foo"), { message: "commitMessage" })
    handle.change(d => (d.foo = "foo"), { message: "commitMessage2" })
    handle.change(d => (d.foo = "foo"), { message: "commitMessage3" })
    handle.change(d => (d.foo = "foo"), { message: "commitMessage4" })
    assert.equal(handle.isReady(), true)

    const history = handle.history()
    const metadata = handle.metadata(history[0][0])
    assert.deepEqual(metadata.message, "commitMessage")
    // NOTE: I'm not testing time because of https://github.com/automerge/automerge/issues/965
    // but it does round-trip successfully!
  })

  /**
   * Once there's a Repo#stop API this case should be covered in accompanying
   * tests and the following test removed.
   */
  // TODO as part of future cleanup: move this to Repo
  it("no pending timers after a document is loaded", async () => {
    vi.useFakeTimers()
    const timerCount = vi.getTimerCount()

    const handle = new DocHandle<TestDoc>(TEST_ID)
    assert.equal(handle.isReady(), false)

    handle.legacyAsyncDoc()

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

    const doc = handle.doc()
    assert.equal(doc?.foo, "pizza")
  })

  it("should not be ready while requesting from the network", async () => {
    const handle = new DocHandle<TestDoc>(TEST_ID)

    // we don't have it in storage, so we request it from the network
    handle.request()

    await expect(() => {
      handle.doc()
    }).toThrowError("DocHandle is not ready")
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

    const doc = handle.doc()
    assert.equal(handle.isReady(), true)
    assert.equal(doc?.foo, "bar")
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

  it("should emit a change message when changes happen", async () => {
    const handle = setup()
    const p = new Promise(resolve => handle.once("change", d => resolve(d)))

    handle.change(doc => {
      doc.foo = "bar"
    })

    await p
    const doc = handle.doc()
    assert.equal(doc?.foo, "bar")
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

  it("should be undefined if loading the document times out", async () => {
    // set docHandle time out after 5 ms
    const handle = new DocHandle<TestDoc>(TEST_ID, { timeoutDelay: 5 })

    expect(() => handle.doc()).toThrowError("DocHandle is not ready")
  })

  it("should not time out if the document is loaded in time", async () => {
    // set docHandle time out after 5 ms
    const handle = new DocHandle<TestDoc>(TEST_ID, { timeoutDelay: 5 })

    // simulate loading from storage before the timeout expires
    handle.update(doc => docFromMockStorage(doc))

    // now it should not time out
    const doc = handle.doc()
    assert.equal(doc?.foo, "bar")
  })

  it("should throw an exception if loading from the network times out", async () => {
    // set docHandle time out after 5 ms
    const handle = new DocHandle<TestDoc>(TEST_ID, { timeoutDelay: 5 })

    // simulate requesting from the network
    handle.request()

    // there's no update
    await pause(10)

    expect(() => handle.doc()).toThrowError("DocHandle is not ready")
  })

  it("should not time out if the document is updated in time", async () => {
    // set docHandle time out after 5 ms
    const handle = setup({ timeoutDelay: 1 })

    // simulate requesting from the network
    handle.request()

    // simulate updating from the network before the timeout expires
    handle.update(doc => {
      return A.change(doc, d => (d.foo = "bar"))
    })

    // now it should not time out
    await pause(5)

    const doc = handle.doc()
    assert.equal(doc?.foo, "bar")
  })

  it("should emit a delete event when deleted", async () => {
    const handle = setup()

    const p = new Promise<void>(resolve =>
      handle.once("delete", () => resolve())
    )
    handle.delete()
    await p

    assert.equal(handle.isDeleted(), true)
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
})
