import { next as A } from "@automerge/automerge"
import { describe, expect, it, vi } from "vitest"
import { encodeHeads } from "../src/AutomergeUrl.js"
import { DocumentState } from "../src/DocumentState.js"
import { automerge } from "../src/automerge/docType.js"
import type { AnyDocType } from "../src/DocType.js"
import { noopOwner } from "./helpers/testHandle.js"
import type { DocumentId, UrlHeads } from "../src/types.js"
import { flushGC, gcAvailable, waitForGC } from "./helpers/flushGC.js"

const itGC = gcAvailable ? it : it.skip

type TestDoc = { count: number }

/** A document with two states: `oldHeads` (count: 1) and the live doc (count: 2). */
const setup = (): { document: DocumentState; oldHeads: UrlHeads } => {
  let doc = A.from<TestDoc>({ count: 1 })
  const oldHeads = encodeHeads(A.getHeads(doc))
  doc = A.change(doc, d => {
    d.count = 2
  })
  return {
    document: new DocumentState("test-doc-id" as DocumentId, noopOwner, doc),
    oldHeads,
  }
}

describe("DocumentState view cache", () => {
  it("returns the live doc when no heads are given", () => {
    const { document } = setup()
    expect(document.viewAt(undefined)).toBe(document.current)
  })

  it("materializes the doc at historical heads", () => {
    const { document, oldHeads } = setup()
    expect((document.viewAt(oldHeads) as TestDoc).count).toBe(1)
    expect((document.current as TestDoc).count).toBe(2)
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
      probe = new WeakRef(document.viewAt(oldHeads) as object)
    })()

    expect(await waitForGC(probe)).toBe(true)

    // A cold read recomputes an equivalent view.
    expect((document.viewAt(oldHeads) as TestDoc).count).toBe(1)
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

describe("DocumentState with states that are not objects", () => {
  // A doc type whose state is a plain number (or null): its own heads are its value.
  const makeNumeric = () => {
    const apply = vi.fn(() => 99)
    const docType = {
      ...automerge,
      name: "numeric",
      apply,
      heads: (n: number | null) => [String(n)],
      view: (n: number) => n - 1,
    } as unknown as AnyDocType
    const setup = (initial?: number | null) =>
      new DocumentState(
        "test-doc-id" as DocumentId,
        {
          ...noopOwner,
          docType,
        },
        initial
      )
    return { apply, setup }
  }

  it("keeps a falsy state rather than making a new one", () => {
    for (const value of [0, null] as const) {
      const { apply, setup } = makeNumeric()
      const document = setup(value)
      expect(document.peek()).toBe(value)
      expect(document.current).toBe(value)
      expect(document.heads()).toEqual([String(value)])
      expect(apply).not.toHaveBeenCalled()
    }
  })

  it("returns views that cannot be cached", () => {
    const { setup } = makeNumeric()
    const document = setup(5)
    const heads = encodeHeads([])
    expect(document.viewAt(heads)).toBe(4)
    expect(document.viewAt(heads)).toBe(4)
  })
})
