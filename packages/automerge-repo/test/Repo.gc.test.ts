import { describe, expect, it, vi } from "vitest"
import { Repo } from "../src/Repo.js"
import { DummyStorageAdapter } from "../src/helpers/DummyStorageAdapter.js"
import type { DocHandle } from "../src/DocHandle.js"
import type { AutomergeUrl, DocumentId, PeerId } from "../src/index.js"
import connectRepos from "./helpers/connectRepos.js"
import { flushGC, gcAvailable, waitForGC } from "./helpers/flushGC.js"

const describeGC = gcAvailable ? describe : describe.skip

type TestDoc = { foo: string }

/**
 * End-to-end tests for the consumer-driven memory model: holding a handle
 * (or keeping a listener attached) keeps a document loaded; dropping every
 * reference lets the Repo release all of its per-document coordination
 * state (query, synchronizer, handles, registry) automatically.
 */
describeGC("Repo GC of dropped documents", () => {
  it("collects a document once the consumer drops its handle", async () => {
    const repo = new Repo()
    let documentId!: DocumentId
    let probe!: WeakRef<DocHandle<TestDoc>>

      // Scope the handle so the test frame doesn't pin it.
    ;(() => {
      const handle = repo.create<TestDoc>({ foo: "dropped" })
      documentId = handle.documentId
      probe = new WeakRef(handle)
    })()

    expect(await waitForGC(probe, 2000)).toBe(true)
    expect(repo.handles[documentId]).toBeUndefined()
    expect(repo.synchronizer.docSynchronizers[documentId]).toBeUndefined()
  })

  it("collects a document once root and sub-handles are all dropped", async () => {
    const repo = new Repo()
    let documentId!: DocumentId
    let rootProbe!: WeakRef<DocHandle<any>>
    let subProbe!: WeakRef<DocHandle<string>>

      // Scope root and sub together, with listener churn on the sub, so the
      // whole cluster (root, subs, registry wiring) must collapse as a unit.
    ;(() => {
      const root = repo.create<any>({ nested: { value: "dropped" } })
      documentId = root.documentId
      const sub = root.sub("nested", "value")
      const listener = () => {}
      sub.on("change", listener)
      sub.off("change", listener)
      rootProbe = new WeakRef(root)
      subProbe = new WeakRef(sub)
    })()

    expect(await waitForGC(rootProbe, 2000)).toBe(true)
    expect(await waitForGC(subProbe, 2000)).toBe(true)
    expect(repo.handles[documentId]).toBeUndefined()
    expect(repo.synchronizer.docSynchronizers[documentId]).toBeUndefined()
  })

  it("keeps a document alive while the consumer holds a handle", async () => {
    const repo = new Repo()
    const handle = repo.create<TestDoc>({ foo: "held" })

    // Negative assertion: a best-effort GC must not evict a held document.
    await flushGC()

    expect(repo.handles[handle.documentId]).toBe(handle)
    expect(repo.synchronizer.docSynchronizers[handle.documentId]).toBeDefined()
  })

  it("keeps the whole document alive while only a sub-handle is held", async () => {
    const repo = new Repo()
    let sub!: DocHandle<string>
    let rootProbe!: WeakRef<DocHandle<any>>

    ;(() => {
      const root = repo.create<any>({ nested: { value: "kept" } })
      rootProbe = new WeakRef(root)
      sub = root.sub("nested", "value")
    })()

    await flushGC()

    // The sub-handle reaches the shared document, whose registry retains
    // the root handle (it carries the repo's internal listeners).
    expect(rootProbe.deref()).toBeDefined()
    expect(repo.handles[sub.documentId]).toBeDefined()
    expect(sub.doc()).toBe("kept")
  })

  it("re-loads a collected document from storage on the next find()", async () => {
    const storage = new DummyStorageAdapter()
    const repo = new Repo({ storage })
    let url!: AutomergeUrl
    let probe!: WeakRef<DocHandle<TestDoc>>

    ;(() => {
      const handle = repo.create<TestDoc>({ foo: "persisted" })
      url = handle.url
      probe = new WeakRef(handle)
    })()
    await repo.flush()

    expect(await waitForGC(probe, 2000)).toBe(true)

    // The cache miss re-loads through the ordinary ensureQuery path.
    const fresh = await repo.find<TestDoc>(url)
    expect(fresh.doc()).toEqual({ foo: "persisted" })

    // The re-created document gets fresh storage wiring: a new change
    // persists and survives a reload from the same storage in another repo.
    fresh.change(d => {
      d.foo = "persisted-again"
    })
    await repo.flush()
    const other = new Repo({ storage })
    const reloaded = await other.find<TestDoc>(url)
    expect(reloaded.doc()).toEqual({ foo: "persisted-again" })
  })

  it("a listener keeps the document rooted after the handle is dropped", async () => {
    const repo = new Repo()
    let url!: AutomergeUrl
    let documentId!: DocumentId
    const events: string[] = []

    ;(() => {
      const handle = repo.create<TestDoc>({ foo: "start" })
      url = handle.url
      documentId = handle.documentId
      handle.on("change", ({ doc }) => {
        if (doc) events.push(doc.foo)
      })
    })()

    // Negative assertion: the external listener roots the document even
    // though no handle is held anywhere.
    await flushGC()
    expect(repo.handles[documentId]).toBeDefined()

    // The registry canonicalizes handles, so a re-find returns the same
    // instance the listener was attached to, and changes still reach it.
    let probe!: WeakRef<DocHandle<TestDoc>>
    await (async () => {
      const again = await repo.find<TestDoc>(url)
      probe = new WeakRef(again)
      again.change(d => {
        d.foo = "updated"
      })
      expect(events).toEqual(["updated"])

      // Removing the listener releases the root; dropping the handle then
      // lets the whole document go.
      again.removeAllListeners()
    })()

    expect(await waitForGC(probe, 2000)).toBe(true)
    expect(repo.handles[documentId]).toBeUndefined()
  })

  it("removeFromCache severs listener rooting", async () => {
    const repo = new Repo()
    let documentId!: DocumentId
    let probe!: WeakRef<DocHandle<TestDoc>>

    ;(() => {
      const handle = repo.create<TestDoc>({ foo: "torn-down" })
      documentId = handle.documentId
      probe = new WeakRef(handle)
      handle.on("change", () => {})
    })()

    await repo.removeFromCache(documentId)

    // Explicit teardown wins over the lingering listener.
    expect(await waitForGC(probe, 2000)).toBe(true)
    expect(repo.handles[documentId]).toBeUndefined()
  })

  it("collects a document created only by inbound sync once sync settles", async () => {
    // Sync-server shape: bob receives and serves a document without any
    // local consumer ever holding a handle to it.
    const alice = new Repo({ peerId: "alice" as PeerId })
    const bob = new Repo({ peerId: "bob" as PeerId })
    await connectRepos(alice, bob)

    const aliceHandle = alice.create<TestDoc>({ foo: "shared" })
    const documentId = aliceHandle.documentId

    let probe!: WeakRef<DocHandle<TestDoc>>
    await (async () => {
      const bobHandle = await bob.find<TestDoc>(aliceHandle.url)
      probe = new WeakRef(bobHandle)
      expect(bobHandle.doc()).toEqual({ foo: "shared" })
    })()

    // With no consumer references on bob's side, bob's copy is collectable.
    // (The sync-throttle timer pins it briefly; the budget outlasts it.)
    expect(await waitForGC(probe, 3000)).toBe(true)
    expect(bob.handles[documentId]).toBeUndefined()
    expect(bob.synchronizer.docSynchronizers[documentId]).toBeUndefined()

    // A fresh find re-requests the document from alice.
    const again = await bob.find<TestDoc>(aliceHandle.url)
    expect(again.doc()).toEqual({ foo: "shared" })
  })
})

describeGC("Repo GC cross-cutting pins", () => {
  const SAVE_DEBOUNCE_MS = 100

  it("a pending save throttle pins the handle until it fires", async () => {
    // The heads-changed save listener retains {handle, doc} through the
    // throttle's pending setTimeout, so a change always reaches storage
    // even if the consumer drops the handle immediately afterwards.
    // Partial fake timers capture the throttle while setImmediate stays
    // real for the GC helpers' macrotask yields.
    let probe!: WeakRef<DocHandle<TestDoc>>
    const repo = new Repo({
      storage: new DummyStorageAdapter(),
      saveDebounceRate: SAVE_DEBOUNCE_MS,
    })

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      ;(() => {
        const handle = repo.create<TestDoc>({ foo: "bar" })
        handle.change(d => {
          d.foo = "baz"
        })
        probe = new WeakRef(handle)
      })()

      // The throttle timer has not fired: its closure pins the handle.
      await flushGC()
      expect(probe.deref()).toBeDefined()

      // Fire the pending save (and sync) throttles, releasing the closures.
      await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS * 2 + 50)
    } finally {
      vi.useRealTimers()
    }

    expect(await waitForGC(probe, 2000)).toBe(true)
  })

  it("a repo.handles snapshot pins; a later snapshot reflects the drop", async () => {
    let probe!: WeakRef<DocHandle<TestDoc>>
    let documentId!: DocumentId
    let snapshot: Record<DocumentId, DocHandle<any>> | undefined
    const repo = new Repo({
      storage: new DummyStorageAdapter(),
      saveDebounceRate: SAVE_DEBOUNCE_MS,
    })

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      ;(() => {
        const handle = repo.create<TestDoc>({ foo: "bar" })
        documentId = handle.documentId
        probe = new WeakRef(handle)
      })()
      await repo.flush()
      await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS * 2 + 50)
      // The snapshot Record strongly references the handle.
      snapshot = repo.handles
    } finally {
      vi.useRealTimers()
    }

    await flushGC()
    expect(probe.deref()).toBeDefined()
    expect(snapshot![documentId]).toBeDefined()

    snapshot = undefined
    // Handle collected AND a fresh snapshot no longer lists it (the weak
    // map's iterator skips dead entries).
    expect(
      await waitForGC(
        () =>
          probe.deref() === undefined && repo.handles[documentId] === undefined,
        2000
      )
    ).toBe(true)
  })
})
