import { next as A } from "@automerge/automerge"
import { describe, expect, it, vi } from "vitest"
import { DocHandle } from "../src/DocHandle.js"
import { Document } from "../src/Document.js"
import { DocumentQuery } from "../src/DocumentQuery.js"
import type { DocumentId } from "../src/types.js"
import {
  kOnInternal,
  kOnRetainChange,
  kReleaseDocument,
  kRetainDocument,
  kSeverRetention,
  kSubscribeInternal,
} from "../src/internals.js"

type TestDoc = { count: number }

const makeDocument = (initial?: TestDoc) =>
  new Document<TestDoc>(
    "test-doc-id" as DocumentId,
    initial ? A.from(initial) : A.init()
  )

describe("Document external retention", () => {
  it("reports only the 0→1 and 1→0 transitions", () => {
    const document = makeDocument()
    const changes: boolean[] = []
    document[kOnRetainChange] = retained => changes.push(retained)

    document[kRetainDocument]()
    document[kRetainDocument]()
    expect(changes).toEqual([true])

    document[kReleaseDocument]()
    expect(changes).toEqual([true])
    document[kReleaseDocument]()
    expect(changes).toEqual([true, false])
  })

  it("ignores unbalanced releases", () => {
    const document = makeDocument()
    const changes: boolean[] = []
    document[kOnRetainChange] = retained => changes.push(retained)

    document[kReleaseDocument]()
    expect(changes).toEqual([])

    document[kRetainDocument]()
    document[kReleaseDocument]()
    document[kReleaseDocument]()
    document[kRetainDocument]()
    expect(changes).toEqual([true, false, true])
  })

  it("severRetention drops retention and silences future changes", () => {
    const document = makeDocument()
    const changes: boolean[] = []
    document[kOnRetainChange] = retained => changes.push(retained)

    document[kRetainDocument]()
    document[kSeverRetention]()
    expect(changes).toEqual([true, false])

    document[kRetainDocument]()
    expect(changes).toEqual([true, false])
  })

  describe("via DocHandle listeners", () => {
    it("a public listener retains; removing it releases", () => {
      const document = makeDocument({ count: 1 })
      const onRetainChange = vi.fn()
      document[kOnRetainChange] = onRetainChange
      const handle = new DocHandle<TestDoc>(document, {})

      const listener = () => {}
      handle.on("change", listener)
      expect(onRetainChange).toHaveBeenLastCalledWith(true)

      handle.off("change", listener)
      expect(onRetainChange).toHaveBeenLastCalledWith(false)
    })

    it("an internal listener does not retain", () => {
      const document = makeDocument({ count: 1 })
      const onRetainChange = vi.fn()
      document[kOnRetainChange] = onRetainChange
      const handle = new DocHandle<TestDoc>(document, {})

      handle[kOnInternal]("heads-changed", () => {})
      expect(onRetainChange).not.toHaveBeenCalled()
    })

    it("a once() listener releases after it fires", () => {
      const document = makeDocument({ count: 1 })
      const onRetainChange = vi.fn()
      document[kOnRetainChange] = onRetainChange
      const handle = new DocHandle<TestDoc>(document, {})

      handle.once("change", () => {})
      expect(onRetainChange).toHaveBeenLastCalledWith(true)

      handle.change(d => {
        d.count = 2
      })
      expect(onRetainChange).toHaveBeenLastCalledWith(false)
    })

    it("removeAllListeners releases every external listener", () => {
      const document = makeDocument({ count: 1 })
      const changes: boolean[] = []
      document[kOnRetainChange] = retained => changes.push(retained)
      const handle = new DocHandle<TestDoc>(document, {})
      const sub = handle.sub("count")

      handle.on("change", () => {})
      handle.on("heads-changed", () => {})
      sub.on("change", () => {})
      expect(changes).toEqual([true])

      handle.removeAllListeners()
      expect(changes).toEqual([true])
      sub.removeAllListeners()
      expect(changes).toEqual([true, false])
    })

    it("off(event) without a callback releases that event's external listeners", () => {
      const document = makeDocument({ count: 1 })
      const changes: boolean[] = []
      document[kOnRetainChange] = retained => changes.push(retained)
      const handle = new DocHandle<TestDoc>(document, {})

      const listenerA = () => {}
      const listenerB = () => {}
      const internal = () => {}
      handle[kOnInternal]("change", internal)
      handle.on("change", listenerA)
      handle.on("change", listenerB)
      handle.on("heads-changed", listenerA)
      expect(handle.listeners("change")).toContain(listenerA)

      handle.off("change")
      expect(handle.listeners("change")).toEqual([internal])
      // Still retained by the heads-changed listener.
      expect(changes).toEqual([true])

      handle.off("heads-changed")
      expect(changes).toEqual([true, false])
    })

    it("off(event, fn) removes a once() wrapper by the original listener", () => {
      const document = makeDocument({ count: 1 })
      const changes: boolean[] = []
      document[kOnRetainChange] = retained => changes.push(retained)
      const handle = new DocHandle<TestDoc>(document, {})

      const listener = vi.fn()
      handle.once("change", listener)
      expect(changes).toEqual([true])

      handle.off("change", listener)
      expect(changes).toEqual([true, false])

      handle.change(d => {
        d.count = 2
      })
      expect(listener).not.toHaveBeenCalled()
    })

    it("public removal leaves repo-internal listeners attached", () => {
      const document = makeDocument({ count: 1 })
      const handle = new DocHandle<TestDoc>(document, {})

      const seen: number[] = []
      const internal = () => seen.push(handle.doc()!.count)
      handle[kOnInternal]("change", internal)
      handle.on("change", () => {})

      handle.removeAllListeners()
      expect(handle.listeners("change")).toEqual([internal])

      // Removing a scraped internal function through the public API is a
      // no-op: it stays attached and keeps firing.
      handle.off("change", internal as never)
      handle.change(d => {
        d.count = 2
      })
      expect(seen).toEqual([2])
    })

    it("adding the same listener twice retains once", () => {
      const document = makeDocument({ count: 1 })
      const changes: boolean[] = []
      document[kOnRetainChange] = retained => changes.push(retained)
      const handle = new DocHandle<TestDoc>(document, {})

      const listener = () => {}
      handle.on("change", listener)
      handle.on("change", listener)
      handle.off("change", listener)
      expect(changes).toEqual([true, false])
    })
  })

  describe("via DocumentQuery subscribers", () => {
    it("subscribe retains; unsubscribe releases exactly once", () => {
      const document = makeDocument({ count: 1 })
      const changes: boolean[] = []
      document[kOnRetainChange] = retained => changes.push(retained)
      const handle = new DocHandle<TestDoc>(document, {})
      const query = new DocumentQuery(handle)

      const unsubscribe = query.subscribe(() => {})
      expect(changes).toEqual([true])

      unsubscribe()
      unsubscribe()
      expect(changes).toEqual([true, false])
    })

    it("subscribing the same callback internally then externally stays balanced", () => {
      const document = makeDocument({ count: 1 })
      const changes: boolean[] = []
      document[kOnRetainChange] = retained => changes.push(retained)
      const handle = new DocHandle<TestDoc>(document, {})
      const query = new DocumentQuery(handle)

      const callback = () => {}
      const unsubInternal = query[kSubscribeInternal](callback)
      const unsubExternal = query.subscribe(callback)
      expect(changes).toEqual([])

      // The duplicate external subscription owns nothing: its unsubscribe
      // neither removes the internal entry nor releases retention.
      unsubExternal()
      unsubInternal()
      expect(changes).toEqual([])

      const unsubscribe = query.subscribe(callback)
      expect(changes).toEqual([true])
      unsubscribe()
      expect(changes).toEqual([true, false])
    })

    it("an internal query subscriber does not retain", () => {
      const document = makeDocument({ count: 1 })
      const onRetainChange = vi.fn()
      document[kOnRetainChange] = onRetainChange
      const handle = new DocHandle<TestDoc>(document, {})
      const query = new DocumentQuery(handle)

      const unsubscribe = query[kSubscribeInternal](() => {})
      unsubscribe()
      expect(onRetainChange).not.toHaveBeenCalled()
    })

    it("a pending whenReady retains until it settles", async () => {
      const document = makeDocument()
      const changes: boolean[] = []
      document[kOnRetainChange] = retained => changes.push(retained)
      const handle = new DocHandle<TestDoc>(document, {})
      const query = new DocumentQuery(
        handle,
        new Map([["storage", { priority: 1 }]])
      )

      const ready = query.whenReady()
      expect(changes).toEqual([true])

      handle.update(() => A.from({ count: 1 }))
      await expect(ready).resolves.toBe(handle)
      expect(changes).toEqual([true, false])
    })
  })
})
