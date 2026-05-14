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
 * timer pins the handle — orthogonal to the FinalizationRegistry cleanup
 * we're actually testing. Wall-clock dependence on `saveDebounceRate` is
 * the exact thing fake timers eliminate.
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

/**
 * Pinning behaviors that consumers may inadvertently rely on (or be
 * surprised by). Each test is a regression guard for an observable
 * design property — the asyncThrottle save timer, `Repo.handles`
 * snapshot semantics, and the subscriber → query → handle reference
 * chain.
 */
describe("Repo handle cleanup — cross-cutting behaviors", () => {
  itGC(
    "pending throttle setTimeout pins the handle until it fires",
    /**
     * Why this matters
     * ----------------
     * `StorageSource`'s `heads-changed → asyncThrottle(saveFn, ...)` schedules
     * a `setTimeout` whose callback retains `{handle, doc}` through closure.
     * Until the timer fires, the handle is reachable from the host timer
     * queue → callback → args → handle.
     *
     * Implications for consumers:
     *   - Changes via `handle.change()` will reach storage even if the
     *     consumer drops the handle immediately afterward — the throttle's
     *     pin guarantees the saveFn runs before GC can collect the handle.
     *   - But the handle is NOT immediately collectable: it lingers until
     *     the throttle setTimeout fires (default `saveDebounceRate = 100ms`).
     *     `repo.flush(id)` saves directly via the storage subsystem, but
     *     does NOT cancel a pending throttle; consumers wanting prompt
     *     reclamation must wait for the throttle to settle after flushing.
     *
     * Regression guard: if someone changes the throttle to capture
     * references differently — e.g. a stable wrapper that doesn't release
     * its closure on settle — this test catches the new leak.
     *
     * Sequence
     * --------
     *   1. Create a doc and call `change()` — schedules a throttle
     *      `setTimeout` whose callback retains `{handle, doc}`.
     *   2. Drop the handle (IIFE scope); capture `WeakRef` as `probe`.
     *   3. `flushGC()` (fixed rounds, negative assertion) — should NOT
     *      collect: the throttle's pending setTimeout pins the handle.
     *   4. `vi.advanceTimersByTimeAsync(...)` fires the throttle. The
     *      callback runs (no-op since `flush()` already saved), the
     *      closure releases, the handle becomes collectable.
     *   5. `waitForGC(probe)` — collects.
     *
     * Implementation note — partial fake timers
     * -----------------------------------------
     * We pass `toFake: ['setTimeout', 'clearTimeout']` so that the throttle
     * setTimeout is captured by the fake queue but `setImmediate` stays
     * real. `flushGC` / `waitForGC` need real `setImmediate` for their
     * macrotask yields; faking it would block their forward progress.
     */
    async () => {
      let probe!: WeakRef<object>
      let repo!: Repo

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      try {
        repo = setup().repo
        ;(() => {
          const handle = repo.create<TestDoc>({ foo: "bar" })
          handle.change(d => (d.foo = "baz"))
          probe = new WeakRef(handle)
        })()

        // Do NOT advance fake time — the throttle setTimeout sits in the
        // fake queue, its callback retaining the handle via closure.
        await flushGC()
        expect(probe.deref()).toBeDefined()

        // Fire the throttle; the callback releases the closure.
        await vi.advanceTimersByTimeAsync(SAVE_THROTTLE_MS * 2)
      } finally {
        vi.useRealTimers()
      }

      expect(await waitForGC(probe)).toBe(true)
    }
  )

  itGC(
    "Repo.handles snapshot pins; a later snapshot reflects drops",
    /**
     * Why this matters
     * ----------------
     * `Repo.handles` is a getter that returns a fresh
     * `Record<DocumentId, DocHandle>` each call — a snapshot, not a live
     * view. The Record strongly references its values, so:
     *   - A consumer iterating the snapshot stays correct (no mid-iteration
     *     mutation).
     *   - Holding the snapshot prevents the underlying handles from being
     *     GC-collected, even after the consumer drops its own references.
     *   - A subsequent call to `repo.handles` returns a new snapshot that
     *     reflects current liveness (entries are absent for collected
     *     handles, via the WeakValueMap's `entries()` iterator skipping
     *     dead entries).
     *
     * Regression guard:
     *   - If someone changes the getter to return a live `Map` view (would
     *     break snapshot semantics — callers iterating would see mid-call
     *     mutations from concurrent GC).
     *   - If someone weakens the Record's values (would change observable
     *     lifetime semantics: holding a snapshot would no longer pin).
     *
     * Useful for sync-server diagnostics that snapshot `repo.handles` for
     * metrics — the snapshot needs to be self-consistent for the duration
     * the operator holds it.
     *
     * Sequence
     * --------
     *   1. Create a doc; capture `WeakRef` as `probe`.
     *   2. `const snapshot = repo.handles` — Record with strong ref to handle.
     *   3. Drop the original handle reference (IIFE scope).
     *   4. `flushGC()` (negative) — should NOT collect: the snapshot pins it.
     *   5. Drop the snapshot reference.
     *   6. `waitForGC(probe)` — collects.
     *   7. `repo.handles` returns a fresh Record without the documentId.
     */
    async () => {
      let probe!: WeakRef<object>
      let documentId!: DocumentId
      let repo!: Repo
      let snapshot: Record<DocumentId, unknown> | undefined

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

        // Capture a snapshot — the Record strongly references the handle.
        snapshot = repo.handles
      } finally {
        vi.useRealTimers()
      }

      // Snapshot pins the handle; flushGC should NOT collect.
      await flushGC()
      expect(probe.deref()).toBeDefined()
      expect(snapshot![documentId]).toBeDefined()

      // Release the snapshot — no other strong refs remain.
      snapshot = undefined

      // Combined predicate: handle GC'd AND fresh snapshot no longer
      // includes the documentId (verifies the WeakValueMap iterator
      // skips the dead entry).
      expect(
        await waitForGC(
          () =>
            probe.deref() === undefined &&
            repo.handles[documentId] === undefined
        )
      ).toBe(true)
    }
  )

  itGC(
    "a query subscriber pins both the query and its handle",
    /**
     * Why this matters
     * ----------------
     * `DocumentQuery.subscribe(callback)` adds `callback` to the query's
     * internal `#subscribers` set and returns an `unsubscribe` function
     * that closes over `this` (the query) and `callback`. So whoever
     * holds the `unsubscribe` reference also (transitively) holds the
     * query — and `DocumentQuery.#handle` is a strong field, so the
     * query holds the handle too.
     *
     * Reference chain while `unsubscribe` is held:
     *   unsubscribe → query → query.#handle → handle
     *
     * This is the structural reason the design does NOT need a "collected"
     * `QueryState` variant: a `DocumentQuery` cannot outlive its handle.
     * Any path that keeps the query reachable also keeps the handle
     * reachable. The asymmetry doesn't exist.
     *
     * Implications for consumers:
     *   - Reactive UIs that `subscribe` and forget to `unsubscribe` will
     *     keep the handle alive. Intentional. Drop the unsubscribe to
     *     allow reclamation.
     *
     * Regression guard: if someone weakens `DocumentQuery.#handle` to a
     * `WeakRef` in the future, the chain breaks and this test fails —
     * forcing the design discussion (do we want a "collected" QueryState
     * variant?) back into scope before the change can land.
     *
     * Sequence
     * --------
     *   1. Create a doc; capture `WeakRef` as `probe`.
     *   2. Get the query via `Repo[testInternals]`. Call `query.subscribe`
     *      with a no-op callback; keep the returned `unsubscribe`.
     *   3. Drop the handle reference (IIFE scope).
     *   4. `flushGC()` (negative) — should NOT collect: `unsubscribe` pins
     *      query, query pins handle.
     *   5. Drop the `unsubscribe` reference.
     *   6. `waitForGC(probe)` — collects.
     */
    async () => {
      let probe!: WeakRef<object>
      let repo!: Repo
      let unsubscribe: (() => void) | undefined

      vi.useFakeTimers()
      try {
        repo = setup().repo
        ;(() => {
          const handle = repo.create<TestDoc>({ foo: "bar" })
          probe = new WeakRef(handle)

          const internals = Repo[testInternals](repo)
          const query = internals.queriesByHandle.get(handle)
          if (!query) throw new Error("query missing for freshly-created doc")
          unsubscribe = query.subscribe(() => {})
        })()

        await repo.flush()
        await vi.advanceTimersByTimeAsync(SAVE_THROTTLE_MS * 2)
      } finally {
        vi.useRealTimers()
      }

      // Confirm the unsubscribe function is what we expect — and the
      // act of reading it keeps the static-analyzer happy. The
      // load-bearing thing for the test is that the variable still
      // strongly references the closure across the flushGC below.
      expect(typeof unsubscribe).toBe("function")

      // Subscriber chain pins the handle.
      await flushGC()
      expect(probe.deref()).toBeDefined()

      // Drop the unsubscribe reference. Not calling unsubscribe() is
      // sufficient — the closure-captured query is what pins. Calling
      // it would only remove the callback from the subscriber set; the
      // closure still holds the query until the variable releases.
      unsubscribe = undefined

      expect(await waitForGC(probe)).toBe(true)
    }
  )
})
