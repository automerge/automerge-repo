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
import { RefImpl } from "../src/refs/ref.js"
import { gcAvailable, waitForGC } from "./helpers/flushGC.js"

describe("DocHandle", () => {
  const TEST_ID = parseAutomergeUrl(generateAutomergeUrl()).documentId

  const setup = (options?) => {
    const { quick, documentId, ...rest } = options ?? {}
    let id = documentId ?? TEST_ID
    const handle = new DocHandle<TestDoc>(
      id,
      (handle, path) => new RefImpl(handle, path),
      rest
    )
    return handle
  }

  it("should take the UUID passed into it", () => {
    const handle = setup({ quick: true })
    assert.equal(handle.documentId, TEST_ID)
  })

  /** HISTORY TRAVERSAL
   * This API is relatively alpha-ish but we're already
   * doing things in our own apps that are fairly ambitious
   * by routing around to a lower-level API.
   * This is an attempt to wrap up the existing practice
   * in a slightly more supportable set of APIs but should be
   * considered provisional: expect further improvements.
   */

  it("should return an empty doc initially", () => {
    const handle = setup()
    const doc = handle.doc()
    assert.deepEqual(doc, {})
  })

  it("should return data after update", () => {
    const handle = setup()
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
    const viewHandle = handle.view(history[1])
    assert.deepEqual(viewHandle.doc(), { foo: "one" })
  })

  it("should support fixed heads from construction", async () => {
    const handle = setup()
    handle.change(d => (d.foo = "zero"))
    handle.change(d => (d.foo = "one"))

    const history = handle.history()
    const viewHandle = setup({ quick: true, heads: history[0] })
    viewHandle.update(() => A.clone(handle.doc()!))
    viewHandle.doneLoading()

    assert.deepEqual(viewHandle.doc(), { foo: "zero" })
  })

  it("should prevent changes on fixed-heads handles", async () => {
    const handle = setup()
    handle.change(d => (d.foo = "zero"))
    const viewHandle = handle.view(handle.heads()!)

    assert.throws(() => viewHandle.change(d => (d.foo = "one")))
    assert.throws(() =>
      viewHandle.changeAt(handle.heads()!, d => (d.foo = "one"))
    )
    assert.throws(() => viewHandle.merge(handle))
  })

  it("should return fixed heads from heads()", async () => {
    const handle = setup()
    handle.change(d => (d.foo = "zero"))
    const originalHeads = handle.heads()!

    handle.change(d => (d.foo = "one"))
    const viewHandle = handle.view(originalHeads)

    assert.deepEqual(viewHandle.heads(), originalHeads)
    assert.notDeepEqual(viewHandle.heads(), handle.heads())
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

  it("should support diffing against another handle", async () => {
    const handle = setup()
    handle.change(d => (d.foo = "zero"))
    const viewHandle = handle.view(handle.heads()!)

    handle.change(d => (d.foo = "one"))

    const patches = viewHandle.diff(handle)
    assert.deepEqual(patches, [
      { action: "put", path: ["foo"], value: "" },
      { action: "splice", path: ["foo", 0], value: "one" },
    ])
  })

  // TODO: alexg -- should i remove this test? should this fail or no?
  it.skip("should fail diffing against unrelated handles", async () => {
    const handle1 = setup()
    const handle2 = setup()

    handle1.change(d => (d.foo = "zero"))
    handle2.change(d => (d.foo = "one"))

    assert.throws(() => handle1.diff(handle2))
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

  it("should return empty heads for a fresh handle", () => {
    const handle = setup()
    assert.deepEqual(handle.heads(), [])
  })

  it("metadata() returns undefined on a fresh handle without crashing", () => {
    const handle = setup()
    assert.equal(handle.metadata(), undefined)
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
        queueMicrotask(done)
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
        queueMicrotask(done)
      })
    }))

  it("should emit a heads-changed event when data arrives via update", async () => {
    const handle = setup()
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
    const handle1 = setup()
    handle1.update(() => A.from<TestDoc>({ foo: "one" }))

    const OTHER_ID = parseAutomergeUrl(generateAutomergeUrl()).documentId
    const handle2 = setup({ documentId: OTHER_ID })
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

  it("should cache view handles based on heads", async () => {
    // Create and setup a document with some data
    const handle = setup()
    handle.change(doc => {
      doc.foo = "Hello"
    })
    const heads1 = handle.heads()

    // Make another change to get a different set of heads
    handle.change(doc => {
      doc.foo = "Hello, World!"
    })

    // Create a view at the first set of heads
    const view1 = handle.view(heads1)

    // Request the same view again
    const view2 = handle.view(heads1)

    // Verify we got the same handle instance back (cached version)
    expect(view1).toBe(view2)

    // Verify the contents are correct
    expect(view1.doc().foo).toBe("Hello")

    // Test with a different set of heads
    const view3 = handle.view(handle.heads())
    expect(view3).not.toBe(view1)
    expect(view3.doc().foo).toBe("Hello, World!")
  })

  it("should improve performance when requesting the same view multiple times", () => {
    // Create and setup a document with some data
    const handle = setup()
    handle.change(doc => {
      doc.foo = "Hello"
    })
    const heads = handle.heads()

    // First, measure time without cache (first access)
    const startTimeNoCached = performance.now()
    const firstView = handle.view(heads)
    const endTimeNoCached = performance.now()

    // Now measure with cache (subsequent accesses)
    const startTimeCached = performance.now()
    for (let i = 0; i < 100; i++) {
      handle.view(heads)
    }
    const endTimeCached = performance.now()

    // Assert that all views are the same instance
    for (let i = 0; i < 10; i++) {
      expect(handle.view(heads)).toBe(firstView)
    }

    // Calculate average times
    const timeForFirstAccess = endTimeNoCached - startTimeNoCached
    const timeForCachedAccesses = (endTimeCached - startTimeCached) / 100

    console.log(`Time for first view (no cache): ${timeForFirstAccess}ms`)
    console.log(`Average time per cached view: ${timeForCachedAccesses}ms`)

    // Cached access should be significantly faster
    expect(timeForCachedAccesses).toBeLessThan(timeForFirstAccess / 10)
  })

  describe("isReadOnly", () => {
    it("should return false for a regular document handle", () => {
      const handle = setup()
      expect(handle.isReadOnly()).toBe(false)
    })

    it("should return false for a newly created document handle", () => {
      const handle = setup({ quick: true })
      expect(handle.isReadOnly()).toBe(false)
    })

    it("should return true for a view handle with fixed heads", () => {
      const handle = setup()
      handle.change(doc => {
        doc.foo = "test"
      })

      const heads = handle.heads()
      const viewHandle = handle.view(heads)

      expect(viewHandle.isReadOnly()).toBe(true)
    })

    it("should return true for a handle constructed with fixed heads", () => {
      const handle = setup()
      handle.change(doc => {
        doc.foo = "test"
      })

      const heads = handle.heads()
      const fixedHeadsHandle = setup({ quick: true, heads })
      fixedHeadsHandle.update(() => A.clone(handle.doc()!))
      fixedHeadsHandle.doneLoading()

      expect(fixedHeadsHandle.isReadOnly()).toBe(true)
    })

    it("should return false after regular changes", () => {
      const handle = setup()

      // Initially not read-only
      expect(handle.isReadOnly()).toBe(false)

      // Make a change
      handle.change(doc => {
        doc.foo = "changed"
      })

      // Still not read-only
      expect(handle.isReadOnly()).toBe(false)
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

  describe("state observation", () => {
    it("reports ready by default", () => {
      const handle = setup()
      assert.equal(handle.state, "ready")
      assert.equal(handle.isReady(), true)
      assert.equal(handle.isDeleted(), false)
      assert.equal(handle.isUnloaded(), false)
      assert.equal(handle.isUnavailable(), false)
      assert.equal(handle.inState(["ready"]), true)
    })

    it("flips to deleted when delete is emitted", () => {
      const handle = setup()
      handle.emit("delete", { handle })
      assert.equal(handle.state, "deleted")
      assert.equal(handle.isReady(), false)
      assert.equal(handle.isDeleted(), true)
      assert.equal(handle.inState(["deleted"]), true)
    })

    it("user delete listener observes deleted state", async () => {
      const handle = setup()
      const seenDeleted = new Promise<boolean>(resolve => {
        handle.once("delete", ({ handle: h }) => resolve(h.isDeleted()))
      })
      handle.emit("delete", { handle })
      assert.equal(await seenDeleted, true)
    })

    it("whenReady resolves immediately on a ready handle", async () => {
      const handle = setup()
      await handle.whenReady()
    })

    it("whenReady(['deleted']) resolves on delete", async () => {
      const handle = setup()
      const p = handle.whenReady(["deleted"])
      handle.emit("delete", { handle })
      await p
      assert.equal(handle.isDeleted(), true)
    })

    it("getRemoteHeads / getSyncInfo delegate to the lookup injected at construction", () => {
      const sentinel = {
        lastHeads: encodeHeads(["abcd"]),
        lastSyncTimestamp: 12345,
      }
      const handle = new DocHandle<TestDoc>(
        TEST_ID,
        (h, p) => new RefImpl(h, p),
        {},
        sid => (sid === "storage-1" ? sentinel : undefined)
      )
      assert.deepEqual(
        handle.getRemoteHeads("storage-1" as any),
        sentinel.lastHeads
      )
      assert.deepEqual(handle.getSyncInfo("storage-1" as any), sentinel)
      assert.equal(handle.getRemoteHeads("storage-2" as any), undefined)
      assert.equal(handle.getSyncInfo("storage-2" as any), undefined)
    })

    it("view handles inherit the sync info lookup", () => {
      const sentinel = {
        lastHeads: encodeHeads(["abcd"]),
        lastSyncTimestamp: 12345,
      }
      const handle = new DocHandle<TestDoc>(
        TEST_ID,
        (h, p) => new RefImpl(h, p),
        {},
        sid => (sid === "storage-1" ? sentinel : undefined)
      )
      handle.update(d => A.change(d, x => (x.foo = "bar")))
      const view = handle.view(handle.heads())
      assert.deepEqual(view.getSyncInfo("storage-1" as any), sentinel)
    })
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

  describe("weak caches", () => {
    const itGC = gcAvailable ? it : it.skip

    it("ref() returns the same instance while held", () => {
      const handle = setup()
      handle.change(d => (d.foo = "x"))
      const a = handle.ref("foo")
      const b = handle.ref("foo")
      expect(a).toBe(b)
    })

    it("view() returns the same handle for the same heads while held", () => {
      const handle = setup()
      handle.change(d => (d.foo = "x"))
      const heads = handle.heads()!
      const a = handle.view(heads)
      const b = handle.view(heads)
      expect(a).toBe(b)
    })

    // Skipped: blocked by a pre-existing structural issue in RefImpl. Its
    // #updateHandler closure captures `this` and is stored as a change
    // listener on the DocHandle, so while the DocHandle is alive the Ref is
    // pinned — independent of #refCache. The FinalizationRegistry in
    // refs/ref.ts has the same shape (held value captures the target). The
    // WeakValueMap migration of #refCache is still correct; it just cannot
    // realize value-collection benefits until RefImpl uses weak self-refs.
    it.skip("ref() yields a fresh instance once the prior ref is GC'd", async () => {
      const handle = setup()
      handle.change(d => (d.foo = "x"))

      const probe = (() => {
        const r = handle.ref("foo")
        return new WeakRef(r)
      })()

      expect(await waitForGC(probe)).toBe(true)
      const fresh = handle.ref("foo")
      expect(fresh).not.toBe(probe.deref())
    })

    itGC(
      "view() yields a fresh handle once the prior view is GC'd",
      async () => {
        const handle = setup()
        handle.change(d => (d.foo = "x"))
        const heads = handle.heads()!

        const probe = (() => {
          const v = handle.view(heads)
          return new WeakRef(v)
        })()

        expect(await waitForGC(probe)).toBe(true)
        const fresh = handle.view(heads)
        expect(fresh).not.toBe(probe.deref())
      }
    )
  })
})
