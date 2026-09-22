import { next as A } from "@automerge/automerge"
import { describe, expect, it } from "vitest"
import { DocHandle } from "../src/DocHandle.js"
import { Document } from "../src/Document.js"
import { DocumentQuery } from "../src/DocumentQuery.js"
import { Repo } from "../src/Repo.js"
import type { AutomergeUrl, DocumentId } from "../src/types.js"
import { kOnRetainChange } from "../src/internals.js"
import { flushGC, gcAvailable, waitForGC } from "./helpers/flushGC.js"

const itGC = gcAvailable ? it : it.skip

type TestDoc = { count: number }

const makeDocument = () =>
  new Document<TestDoc>("test-doc-id" as DocumentId, A.from({ count: 1 }))

/**
 * Robustness and performance guards for the external-retention refcount:
 * hammer its two choke points (registry listener storage, DocumentQuery
 * subscribers) through their public entry points and assert the count
 * always returns to balance.
 */
describe("Document external retention under churn", () => {
  it("stays balanced across many on/off cycles", () => {
    const document = makeDocument()
    let retains = 0
    let releases = 0
    document[kOnRetainChange] = retained => {
      if (retained) retains++
      else releases++
    }
    const handle = new DocHandle<TestDoc>(document, {})

    const listener = () => {}
    for (let i = 0; i < 10_000; i++) {
      handle.on("change", listener)
      handle.off("change", listener)
    }

    expect(retains).toBe(10_000)
    expect(releases).toBe(10_000)
  })

  it("reports one transition across interleaved listeners and subscribers", () => {
    const document = makeDocument()
    const changes: boolean[] = []
    document[kOnRetainChange] = retained => changes.push(retained)
    const handle = new DocHandle<TestDoc>(document, {})
    const query = new DocumentQuery(handle)
    const sub = handle.sub("count")

    // Interleave acquisitions across all three public entry points...
    const listeners = Array.from({ length: 50 }, (_, i) => () => void i)
    const unsubscribes: (() => void)[] = []
    for (const [i, listener] of listeners.entries()) {
      handle.on("change", listener)
      sub.on("heads-changed", listener)
      unsubscribes.push(query.subscribe(() => {}))
      if (i % 3 === 0) handle.off("change", listener)
    }

    // ...then release them in a different order than acquired.
    for (const unsubscribe of unsubscribes.reverse()) unsubscribe()
    sub.removeAllListeners()
    handle.removeAllListeners()

    // However the pairs interleave, the document reports exactly one
    // rooted period: rooted at the first acquire, released at the last.
    expect(changes).toEqual([true, false])
  })

  it("releases every once() listener after the event fires", () => {
    const document = makeDocument()
    const changes: boolean[] = []
    document[kOnRetainChange] = retained => changes.push(retained)
    const handle = new DocHandle<TestDoc>(document, {})

    for (let i = 0; i < 1000; i++) {
      handle.once("change", () => {})
    }
    handle.change(d => {
      d.count = 2
    })

    expect(changes).toEqual([true, false])
  })

  it("re-roots after a full release", () => {
    const document = makeDocument()
    const changes: boolean[] = []
    document[kOnRetainChange] = retained => changes.push(retained)
    const handle = new DocHandle<TestDoc>(document, {})

    const listener = () => {}
    handle.on("change", listener)
    handle.off("change", listener)
    handle.on("change", listener)

    expect(changes).toEqual([true, false, true])
  })

  it("keeps listener bookkeeping O(1) under load", () => {
    const document = makeDocument()
    document[kOnRetainChange] = () => {}
    const handle = new DocHandle<TestDoc>(document, {})

    // Preload unrelated listeners so an accidental O(n) scan would blow
    // the bound below.
    for (let i = 0; i < 1000; i++) {
      handle.on("heads-changed", () => void i)
    }

    const listener = () => {}
    const start = performance.now()
    for (let i = 0; i < 100_000; i++) {
      handle.on("change", listener)
      handle.off("change", listener)
    }
    const elapsed = performance.now() - start

    // Typically ~50ms; the bound only catches an algorithmic regression.
    expect(elapsed).toBeLessThan(5000)
  })
})

describe("Repo retention under churn (GC-backed)", () => {
  itGC(
    "listener churn across many documents leaves nothing rooted",
    async () => {
      const repo = new Repo()
      const probes: WeakRef<DocHandle<TestDoc>>[] = []

      ;(() => {
        for (let i = 0; i < 200; i++) {
          const handle = repo.create<TestDoc>({ count: i })
          probes.push(new WeakRef(handle))
          const listener = () => {}
          handle.on("change", listener)
          handle.on("heads-changed", listener)
          handle.off("change", listener)
          handle.removeAllListeners()
        }
      })()

      expect(
        await waitForGC(() => probes.every(p => p.deref() === undefined), 5000)
      ).toBe(true)
      expect(Object.keys(repo.handles)).toHaveLength(0)
    }
  )

  itGC("held listeners root all documents until removed", async () => {
    const repo = new Repo()
    const probes: WeakRef<DocHandle<TestDoc>>[] = []
    const documentIds: DocumentId[] = []

    ;(() => {
      for (let i = 0; i < 50; i++) {
        const handle = repo.create<TestDoc>({ count: i })
        probes.push(new WeakRef(handle))
        documentIds.push(handle.documentId)
        handle.on("change", () => {})
      }
    })()

    // Rooted: a best-effort GC collects none of them.
    await flushGC()
    expect(probes.filter(p => p.deref() !== undefined)).toHaveLength(50)

    // Release the roots through the repo's own snapshot, scoped so the
    // snapshot itself doesn't pin anything afterwards.
    ;(() => {
      for (const handle of Object.values(repo.handles)) {
        handle.removeAllListeners()
      }
    })()

    expect(
      await waitForGC(() => probes.every(p => p.deref() === undefined), 5000)
    ).toBe(true)
    for (const documentId of documentIds) {
      expect(repo.handles[documentId]).toBeUndefined()
    }
  })

  itGC("a re-rooted document survives dropping the handle again", async () => {
    const repo = new Repo()
    let url!: AutomergeUrl
    let documentId!: DocumentId

    ;(() => {
      const handle = repo.create<TestDoc>({ count: 1 })
      url = handle.url
      documentId = handle.documentId
      const listener = () => {}
      handle.on("change", listener)
      handle.off("change", listener)
      // Re-acquire after a full release, then drop the handle.
      handle.on("change", listener)
    })()

    // Still rooted by the re-acquired listener.
    await flushGC()
    expect(repo.handles[documentId]).toBeDefined()

    // Releasing through a re-found handle un-roots it for good.
    let probe!: WeakRef<DocHandle<TestDoc>>
    await (async () => {
      const again = await repo.find<TestDoc>(url)
      probe = new WeakRef(again)
      again.removeAllListeners()
    })()

    expect(await waitForGC(probe, 2000)).toBe(true)
    expect(repo.handles[documentId]).toBeUndefined()
  })
})
