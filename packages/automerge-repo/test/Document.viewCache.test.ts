import { next as A } from "@automerge/automerge"
import { describe, expect, it } from "vitest"
import { encodeHeads } from "../src/AutomergeUrl.js"
import { Document } from "../src/Document.js"
import type { DocumentId, UrlHeads } from "../src/types.js"
import { flushGC, gcAvailable, waitForGC } from "./helpers/flushGC.js"

const itGC = gcAvailable ? it : it.skip

type TestDoc = { count: number }

/** A document with two states: `oldHeads` (count: 1) and the live doc (count: 2). */
const setup = (): { document: Document<TestDoc>; oldHeads: UrlHeads } => {
  let doc = A.from<TestDoc>({ count: 1 })
  const oldHeads = encodeHeads(A.getHeads(doc))
  doc = A.change(doc, d => {
    d.count = 2
  })
  return { document: new Document("test-doc-id" as DocumentId, doc), oldHeads }
}

describe("Document view cache", () => {
  it("returns the live doc when no heads are given", () => {
    const { document } = setup()
    expect(document.viewAt(undefined)).toBe(document.doc)
  })

  it("materializes the doc at historical heads", () => {
    const { document, oldHeads } = setup()
    expect(document.viewAt(oldHeads).count).toBe(1)
    expect(document.doc.count).toBe(2)
  })

  it("memoizes a view while it is still referenced", () => {
    const { document, oldHeads } = setup()
    const first = document.viewAt(oldHeads)
    expect(document.viewAt(oldHeads)).toBe(first)
  })

  itGC("releases a view once nothing references it", async () => {
    const { document, oldHeads } = setup()
    let probe!: WeakRef<object>

      // Scope the strong reference to an inner block so it doesn't pin the
      // view via the test stack frame.
    ;(() => {
      probe = new WeakRef(document.viewAt(oldHeads))
    })()

    expect(await waitForGC(probe)).toBe(true)

    // A cold read recomputes an equivalent view.
    expect(document.viewAt(oldHeads).count).toBe(1)
  })

  itGC("keeps a view cached while a consumer holds it", async () => {
    const { document, oldHeads } = setup()
    const held = document.viewAt(oldHeads)

    // Negative assertion: the held view is strongly referenced, so a
    // best-effort GC must leave the cache entry in place.
    await flushGC()

    expect(document.viewAt(oldHeads)).toBe(held)
  })
})
