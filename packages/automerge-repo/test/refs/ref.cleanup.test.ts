import { describe, expect, it, vi } from "vitest"
import { Repo } from "../../src/Repo.js"
import { DummyStorageAdapter } from "../../src/helpers/DummyStorageAdapter.js"
import { DummyNetworkAdapter } from "../../src/helpers/DummyNetworkAdapter.js"
import { flushGC, gcAvailable, waitForGC } from "../helpers/flushGC.js"

const itGC = gcAvailable ? it : it.skip

interface TestDoc {
  foo: string
  nested: { bar: string }
}

/**
 * Test design — fake timers for the throttle phase, real timers for GC.
 *
 * `StorageSource.attach` registers a `heads-changed → asyncThrottle(saveFn,
 * saveDebounceRate)` listener on the handle. The throttle's `setTimeout`
 * retains the saveFn closure (which captures `{handle, doc}`), so a pending
 * timer pins the handle independently of the cleanup work we're testing.
 *
 * Each itGC test activates fake timers around `repo.create` and the throttle
 * settling, then switches to real timers for the GC helpers (`flushGC`,
 * `waitForGC`) which need real `setImmediate` for finalizer drains.
 */

const SAVE_THROTTLE_MS = 100

const setup = () => {
  const storage = new DummyStorageAdapter()
  const network = new DummyNetworkAdapter({ startReady: true })
  const repo = new Repo({ storage, network: [network] })
  return { repo, storage, network }
}

describe("Ref cleanup — listeners don't pin past the handle's lifetime", () => {
  itGC(
    "dropping a handle with refs created from it lets the handle be GC'd",
    /**
     * Why this matters
     * ----------------
     * Before the cleanup refactor, `RefImpl` registered a
     * `FinalizationRegistry` whose held value was an arrow function
     * `() => this.#cleanup()`. The registry holds its held value
     * strongly while the target is alive — so the held value's
     * reference to `this` (the Ref) prevented the Ref from ever
     * becoming collectable. The Ref's strong `docHandle` field then
     * pinned the handle. Net effect: any handle that ever had a Ref
     * created from it was permanently retained.
     *
     * The fix removes the `FinalizationRegistry` entirely. The Ref's
     * `change` listener on the handle still captures `this`, but that
     * forms an internal cycle (`handle → events → listener → this →
     * docHandle → handle`) which is collectable as a unit when
     * nothing external pins either side. So dropping both the handle
     * and the Ref together releases everything.
     *
     * Sequence
     * --------
     *   1. Create a handle and call `handle.ref(path)`.
     *   2. Drop both inside an IIFE; capture a `WeakRef` to the handle.
     *   3. Settle the StorageSource save throttle via fake timers.
     *   4. `waitForGC(handleProbe)` — expect collection.
     */
    async () => {
      let handleProbe!: WeakRef<object>
      let repo!: Repo

      vi.useFakeTimers()
      try {
        repo = setup().repo
        ;(() => {
          const handle = repo.create<TestDoc>({
            foo: "bar",
            nested: { bar: "baz" },
          })
          handleProbe = new WeakRef(handle)
          // Create Refs pinned to the handle. Before the fix, this
          // alone would prevent `handle` from ever being collected.
          handle.ref("foo")
          handle.ref("nested", "bar")
        })()

        await repo.flush()
        await vi.advanceTimersByTimeAsync(SAVE_THROTTLE_MS * 2)
      } finally {
        vi.useRealTimers()
      }

      expect(await waitForGC(handleProbe)).toBe(true)
    }
  )

  itGC(
    "ref.dispose() releases the listener and lets the Ref be GC'd while the handle is held",
    /**
     * Why this matters
     * ----------------
     * Without `dispose()`, a Ref is pinned by its own `change`
     * listener on the handle (the listener closure captures `this`),
     * so the Ref can't be collected while the handle is alive. For
     * consumers who want to release a Ref while keeping the handle —
     * e.g. they created many Refs over time and want to release the
     * ones they're no longer using — `dispose()` removes the listener
     * and resets `#updateHandler` to `noop`, releasing the closure.
     *
     * Sequence
     * --------
     *   1. Hold the handle strongly outside the IIFE.
     *   2. Inside the IIFE, call `handle.ref(path)`, call `dispose()`
     *      on the resulting Ref, and capture a `WeakRef` to it.
     *   3. Settle throttles.
     *   4. `waitForGC(refProbe)` — expect collection.
     *
     * Note: `DocHandle.#refCache` is a `WeakValueMap` that holds the
     * Ref weakly, so it doesn't pin either.
     */
    async () => {
      let refProbe!: WeakRef<object>
      let handle!: ReturnType<Repo["create"]>
      let repo!: Repo

      vi.useFakeTimers()
      try {
        repo = setup().repo
        handle = repo.create<TestDoc>({
          foo: "bar",
          nested: { bar: "baz" },
        })
        ;(() => {
          const ref = handle.ref("foo")
          ref.dispose()
          refProbe = new WeakRef(ref)
        })()

        await repo.flush()
        await vi.advanceTimersByTimeAsync(SAVE_THROTTLE_MS * 2)
      } finally {
        vi.useRealTimers()
      }

      expect(await waitForGC(refProbe)).toBe(true)
      // Sanity: the handle is still alive (we hold it).
      expect(handle.documentId).toBeDefined()
    }
  )

  itGC(
    "a Ref kept alive (without dispose()) keeps its handle alive",
    /**
     * Why this matters
     * ----------------
     * Documents the natural consequence of `Ref.docHandle` being a
     * strong field: while a consumer holds a Ref, the handle is
     * implicitly reachable through it. This is intentional — calling
     * methods on a Ref requires the document to be loaded.
     *
     * Sequence
     * --------
     *   1. Inside an IIFE, create a handle and call `handle.ref(path)`.
     *      Capture a `WeakRef` to the handle. Keep the Ref strong.
     *   2. Settle throttles.
     *   3. `flushGC()` (fixed rounds, negative assertion).
     *   4. Expect the handle to still be alive.
     */
    async () => {
      let handleProbe!: WeakRef<object>
      let ref: unknown
      let repo!: Repo

      vi.useFakeTimers()
      try {
        repo = setup().repo
        ;(() => {
          const handle = repo.create<TestDoc>({
            foo: "bar",
            nested: { bar: "baz" },
          })
          handleProbe = new WeakRef(handle)
          ref = handle.ref("foo")
        })()

        await repo.flush()
        await vi.advanceTimersByTimeAsync(SAVE_THROTTLE_MS * 2)
      } finally {
        vi.useRealTimers()
      }

      // The Ref is held strongly; `Ref.docHandle` keeps the handle alive.
      await flushGC()
      expect(handleProbe.deref()).toBeDefined()

      // Read `ref` so the static-analyzer is content; also documents
      // the test premise (the Ref is what's holding the handle).
      expect(ref).toBeDefined()
    }
  )
})
