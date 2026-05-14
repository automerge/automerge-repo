import { describe, expect, it, vi } from "vitest"
import { Repo } from "../src/Repo.js"
import { testInternals } from "../src/testInternals.js"
import { DummyStorageAdapter } from "../src/helpers/DummyStorageAdapter.js"
import { DummyNetworkAdapter } from "../src/helpers/DummyNetworkAdapter.js"
import { flushGC, gcAvailable, waitForGC } from "./helpers/flushGC.js"
import type { DocumentId } from "../src/types.js"

const itGC = gcAvailable ? it : it.skip

interface TestDoc {
  foo: string
}

/**
 * Test design — fake timers for the throttle phase, real timers for GC.
 *
 * `StorageSource.attach` registers a `heads-changed → asyncThrottle(saveFn,
 * saveDebounceRate)` listener on the handle. The throttle's `setTimeout`
 * retains the saveFn closure (which captures `{handle, doc}`), so a pending
 * timer pins the handle — orthogonal to the §3 coordination cleanup we're
 * actually testing. Wall-clock dependence on `saveDebounceRate` is the
 * exact thing fake timers eliminate.
 *
 * Each itGC test:
 *   1. `vi.useFakeTimers()` — capture the throttle's `setTimeout`.
 *   2. Schedule the work (`repo.create` → emits heads-changed → throttle
 *      schedules a fake-timer setTimeout).
 *   3. `vi.advanceTimersByTimeAsync(...)` — fire the throttle's setTimeout,
 *      releasing the closure that pinned the handle.
 *   4. `vi.useRealTimers()` — switch back. The existing GC helpers use
 *      real `setImmediate` for the macrotask yields that drain
 *      `FinalizationRegistry` callbacks; fake timers would interfere.
 *   5. `waitForGC(...)` with a combined predicate (handle is collected
 *      AND the cleanup callback has run).
 *
 * The `try / finally` around fake-timer activation ensures real timers
 * are restored even if an assertion throws.
 */

const SAVE_THROTTLE_MS = 100

const setup = () => {
  const storage = new DummyStorageAdapter()
  const network = new DummyNetworkAdapter({ startReady: true })
  // Use the default `saveDebounceRate` (100ms). With fake timers in
  // effect, the value never converts to wall-clock — we just advance
  // fake time by `SAVE_THROTTLE_MS * 2` to fire the throttle once.
  const repo = new Repo({ storage, network: [network] })
  return { repo, storage, network }
}

describe("Repo handle cleanup (FinalizationRegistry)", () => {
  itGC(
    "removes the synchronizer entry when the consumer drops the handle",
    async () => {
      let probe!: WeakRef<object>
      let documentId!: DocumentId
      let repo!: Repo

      vi.useFakeTimers()
      try {
        repo = setup().repo
        // Scope the strong ref inside an IIFE so it doesn't survive on
        // the test stack frame after we drop it.
        ;(() => {
          const handle = repo.create<TestDoc>({ foo: "bar" })
          documentId = handle.documentId
          probe = new WeakRef(handle)
        })()

        // Sanity: the synchronizer registered the document.
        expect(repo.synchronizer.docSynchronizers[documentId]).toBeDefined()

        // Persist via the explicit path; this bypasses the throttle so
        // storage has the data regardless of when the throttle fires.
        await repo.flush()

        // Fire the StorageSource asyncThrottle's pending setTimeout —
        // drops the saveFn closure that retained the handle.
        await vi.advanceTimersByTimeAsync(SAVE_THROTTLE_MS * 2)
      } finally {
        vi.useRealTimers()
      }

      // Combined predicate: (a) handle is GC-collected, (b) the
      // FinalizationRegistry callback has fired and run
      // `synchronizer.detach(id)`. The callback runs as a microtask
      // shortly after collection — combined predicate accepts whatever
      // macrotask-yield count is needed for finalizers to drain.
      expect(
        await waitForGC(
          () =>
            probe.deref() === undefined &&
            repo.synchronizer.docSynchronizers[documentId] === undefined
        )
      ).toBe(true)

      expect(repo.handles[documentId]).toBeUndefined()
    }
  )

  itGC(
    "keeps the synchronizer entry while the consumer still holds the handle",
    async () => {
      let handle!: ReturnType<Repo["create"]>
      let repo!: Repo

      vi.useFakeTimers()
      try {
        repo = setup().repo
        handle = repo.create<TestDoc>({ foo: "bar" })
        await repo.flush()
        await vi.advanceTimersByTimeAsync(SAVE_THROTTLE_MS * 2)
      } finally {
        vi.useRealTimers()
      }

      // Strong ref still in scope — best-effort GC should NOT collect it.
      await flushGC()

      expect(
        repo.synchronizer.docSynchronizers[handle.documentId]
      ).toBeDefined()
      expect(repo.handles[handle.documentId]).toBe(handle)
    }
  )

  itGC(
    "find() after drop returns a fresh handle (resurrection from storage)",
    async () => {
      let probe!: WeakRef<object>
      let documentId!: DocumentId
      let repo!: Repo

      vi.useFakeTimers()
      try {
        repo = setup().repo
        ;(() => {
          const original = repo.create<TestDoc>({ foo: "bar" })
          documentId = original.documentId
          probe = new WeakRef(original)
        })()

        await repo.flush()
        await vi.advanceTimersByTimeAsync(SAVE_THROTTLE_MS * 2)
      } finally {
        vi.useRealTimers()
      }

      expect(await waitForGC(probe)).toBe(true)
      expect(repo.handles[documentId]).toBeUndefined()

      // Re-find the same id. Should produce a brand-new handle that
      // re-loads from storage. (Same documentId, different handle
      // instance — proves the cache miss path went through ensureQuery.)
      const fresh = await repo.find<TestDoc>(documentId)
      expect(fresh).toBeDefined()
      expect(fresh.documentId).toBe(documentId)
      expect(fresh.doc()).toMatchObject({ foo: "bar" })
    }
  )

  it("removeFromCache eagerly clears coordination state", async () => {
    // No GC required for this case — the explicit-removal path runs
    // `#unregisterQuery` + `syncStateTracker.delete` synchronously, and
    // the throttle pin is irrelevant to whether `removeFromCache`
    // succeeds. Real timers throughout.
    const { repo } = setup()
    const handle = repo.create<TestDoc>({ foo: "bar" })
    const documentId = handle.documentId
    await repo.flush()

    expect(repo.synchronizer.docSynchronizers[documentId]).toBeDefined()

    await repo.removeFromCache(documentId)

    expect(repo.synchronizer.docSynchronizers[documentId]).toBeUndefined()
    expect(repo.handles[documentId]).toBeUndefined()
  })

  itGC(
    "removeFromCache unregisters the registry: later handle GC is a no-op",
    async () => {
      let probe!: WeakRef<object>
      let documentId!: DocumentId
      let repo!: Repo

      vi.useFakeTimers()
      try {
        repo = setup().repo
        ;(() => {
          const handle = repo.create<TestDoc>({ foo: "bar" })
          documentId = handle.documentId
          probe = new WeakRef(handle)
        })()

        await repo.flush()
        await vi.advanceTimersByTimeAsync(SAVE_THROTTLE_MS * 2)
        await repo.removeFromCache(documentId)
      } finally {
        vi.useRealTimers()
      }

      // The registry entry was already unregistered by removeFromCache,
      // so the callback shouldn't fire — but if it did, it would be a
      // no-op (synchronizer.detach + syncStateTracker.delete are
      // idempotent). Either way the state is correct.
      expect(await waitForGC(probe)).toBe(true)
      expect(repo.synchronizer.docSynchronizers[documentId]).toBeUndefined()
      expect(repo.handles[documentId]).toBeUndefined()
    }
  )

  it("testInternals symbol exposes the syncStateTracker", () => {
    // Static-method form: Repo[testInternals](instance) — verifies that
    // the symbol-keyed escape hatch is reachable from a test, the
    // returned object has the expected shape, and the syncStateTracker
    // is the live instance (not a snapshot).
    const { repo } = setup()
    const internals = Repo[testInternals](repo)
    expect(internals.syncStateTracker).toBe(
      Repo[testInternals](repo).syncStateTracker
    )
    expect(internals.queryHandleByDocumentId).toBeDefined()
    expect(internals.queriesByHandle).toBeDefined()
  })
})
