/**
 * Regression tests for the `#save` resilience invariants in
 * `SubductionSource`:
 *
 *   1. `entry.saveInProgress` is never permanently stuck. The
 *      `try/finally` around the save body guarantees it gets
 *      cleared even if an `await` rejects.
 *
 *   2. Streaming mutation pressure does not hold `entry.saveSettled`
 *      unresolved. Each `#save` invocation processes one batch and
 *      re-arms the throttle if more work was detected during the
 *      await; downstream callers waiting on `saveSettled` see it
 *      resolve in bounded time.
 *
 * These tests use white-box techniques: we substitute a hanging
 * storage adapter and a high-frequency mutation source to exercise
 * the code paths the normal test suite doesn't reach.
 *
 * If the resilience guards regress, downstream callers waiting on
 * `entry.saveSettled` (notably `#doSync` and `Repo.shutdown`) would
 * block indefinitely, leading to test timeouts at best and
 * production hangs at worst.
 */

import { beforeAll, describe, expect, it, vi } from "vitest"

import { Repo } from "../../src/Repo.js"
import { DummyStorageAdapter } from "../../src/helpers/DummyStorageAdapter.js"
import { initSubduction } from "../../src/initSubduction.js"
import type { Chunk, StorageKey } from "../../src/storage/types.js"
import type { StorageAdapterInterface } from "../../src/storage/StorageAdapterInterface.js"

beforeAll(async () => {
  await initSubduction()
})

/**
 * Storage adapter that delegates to a `DummyStorageAdapter` but
 * holds writes until the controlling test releases them. Exposes a
 * `release()` method that resolves all pending writes.
 *
 * Useful for simulating a hung backing store (Risk B from the
 * resilience analysis): we can hold writes for an arbitrary
 * duration, then release and verify that `#save` recovers cleanly.
 */
class GatedStorageAdapter implements StorageAdapterInterface {
  #inner = new DummyStorageAdapter()
  #pending: Array<() => void> = []
  #gated = true

  // Release all pending writes (and any future writes) immediately.
  release() {
    this.#gated = false
    const pending = this.#pending
    this.#pending = []
    for (const resolve of pending) resolve()
  }

  // Pending count, useful to assert we're actually exercising the
  // hung-write path during the test.
  pendingCount() {
    return this.#pending.length
  }

  async #gate(): Promise<void> {
    if (!this.#gated) return
    return new Promise<void>(resolve => {
      this.#pending.push(resolve)
    })
  }

  async loadRange(prefix: StorageKey): Promise<Chunk[]> {
    return this.#inner.loadRange(prefix)
  }

  async removeRange(prefix: StorageKey): Promise<void> {
    return this.#inner.removeRange(prefix)
  }

  async load(key: StorageKey): Promise<Uint8Array | undefined> {
    return this.#inner.load(key)
  }

  async save(key: StorageKey, data: Uint8Array): Promise<void> {
    await this.#gate()
    return this.#inner.save(key, data)
  }

  async remove(key: StorageKey): Promise<void> {
    return this.#inner.remove(key)
  }

  async saveBatch(entries: Array<[StorageKey, Uint8Array]>): Promise<void> {
    await this.#gate()
    return this.#inner.saveBatch(entries)
  }
}

describe("SubductionSource #save resilience", () => {
  it(
    "saveInProgress is cleared after a hung-then-released storage write",
    async () => {
      // GIVEN a Repo with a storage adapter that holds writes until
      // we release them.
      const storage = new GatedStorageAdapter()
      const repo = new Repo({ storage, network: [] })

      try {
        // WHEN the user creates a doc and applies a change. The
        // throttle (~100ms) and `#save` will fire; `subduction
        // .addCommit` will hang on `storage.saveBatch`.
        const handle = repo.create<{ count: number }>({ count: 0 })
        await handle.whenReady()
        handle.change(d => {
          d.count = 1
        })

        // Wait until at least one save attempt has been made — we
        // detect that by polling for pending storage writes.
        await waitForCondition(() => storage.pendingCount() > 0, 5_000)

        // THEN releasing the storage allows the save to drain. If
        // `saveInProgress` were leaking (e.g., because `try/finally`
        // didn't cover the await chain), `repo.flush()` would block
        // forever and the test would time out.
        storage.release()
        await repo.flush()

        // AND a subsequent change can be saved without issue. If the
        // entry's `saveInProgress` were still stuck `true`, the
        // throttle's next firing would early-return and this final
        // change would never be persisted. We assert that we make it
        // through `flush` again within the timeout.
        handle.change(d => {
          d.count = 2
        })
        await repo.flush()
      } finally {
        // Clean up — release any in-flight writes to avoid hanging
        // shutdown.
        storage.release()
        await repo.shutdown()
      }
    },
    15_000
  )

  it(
    "saveInProgress is cleared even if subduction storage writes reject",
    async () => {
      // GIVEN a Repo with a storage adapter that fails ONLY on the
      // `subduction` key prefix (the path that goes through
      // `SubductionStorageBridge.saveCommit` / `saveBatchAll`).
      // Other storage operations succeed so the regular Repo
      // machinery (StorageSubsystem) works.
      //
      // This isolates the test to the SubductionSource `#save` flow:
      // the throw inside `subduction.addCommit` should propagate up
      // through `#saveNewCommits` -> `#save` and trigger the
      // `finally` block that clears `saveInProgress`.
      const storage = new SelectivelyRejectingStorageAdapter("subduction")
      const repo = new Repo({ storage, network: [] })

      try {
        const handle = repo.create<{ count: number }>({ count: 0 })
        await handle.whenReady()
        handle.change(d => {
          d.count = 1
        })

        // Wait for at least one rejection to confirm we're actually
        // exercising the rejection path.
        await waitForCondition(
          () => storage.rejectionCount > 0,
          5_000
        )

        // Make a SECOND change. If `saveInProgress` were stuck `true`
        // from the first failed save, the throttle's next firing
        // would early-return without saving and we'd never see
        // additional rejection attempts. By contrast, if `finally`
        // correctly cleared the flag, the second change triggers a
        // fresh `#save` and produces another rejection.
        const rejectionsBeforeSecondChange = storage.rejectionCount
        handle.change(d => {
          d.count = 2
        })
        await waitForCondition(
          () => storage.rejectionCount > rejectionsBeforeSecondChange,
          5_000
        )

        expect(storage.rejectionCount).toBeGreaterThan(
          rejectionsBeforeSecondChange,
        )
      } finally {
        await repo.shutdown()
      }
    },
    15_000
  )

  it(
    "burst mutations all persist and shutdown completes in bounded time",
    async () => {
      // GIVEN a Repo with normal storage. We trigger a burst of
      // mutations that arm the throttle in rapid succession, and
      // verify that:
      //   - All mutations persist (no work is lost).
      //   - `flush` and `shutdown` complete within a generous
      //     timeout (no `entry.saveSettled` hang).
      //
      // The previous design had a `do { } while (saveAgainAfter)`
      // loop in `#save` that, under pathological mutation patterns
      // where new commits arrived during each iter's await window,
      // could hold `saveSettled` unresolved while iterating. The
      // current single-iter design re-arms the throttle for the
      // next firing instead — `#save` returns promptly, downstream
      // callers waiting on `saveSettled` aren't blocked, and the
      // throttle handles outstanding work.
      const storage = new DummyStorageAdapter()
      const repo = new Repo({ storage, network: [] })

      try {
        const handle = repo.create<{ items: number[] }>({ items: [] })
        await handle.whenReady()

        const N = 200
        for (let i = 0; i < N; i++) {
          handle.change(d => {
            d.items.push(i)
          })
        }

        await repo.flush()

        const finalDoc = handle.doc()
        expect(finalDoc!.items.length).toBe(N)
        expect(finalDoc!.items[0]).toBe(0)
        expect(finalDoc!.items[N - 1]).toBe(N - 1)
      } finally {
        await repo.shutdown()
      }
    },
    30_000
  )
})

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Storage adapter that delegates to `DummyStorageAdapter` for keys
 * NOT starting with the rejecting prefix, and throws for keys that
 * DO. Lets us simulate failures isolated to a single subsystem
 * (e.g., subduction storage) without breaking Repo's own
 * `StorageSubsystem` writes.
 */
class SelectivelyRejectingStorageAdapter implements StorageAdapterInterface {
  rejectionCount = 0
  #inner = new DummyStorageAdapter()
  #rejectPrefix: string

  constructor(rejectPrefix: string) {
    this.#rejectPrefix = rejectPrefix
  }

  #shouldReject(key: StorageKey): boolean {
    return key[0] === this.#rejectPrefix
  }

  async loadRange(prefix: StorageKey): Promise<Chunk[]> {
    return this.#inner.loadRange(prefix)
  }
  async removeRange(prefix: StorageKey): Promise<void> {
    return this.#inner.removeRange(prefix)
  }
  async load(key: StorageKey): Promise<Uint8Array | undefined> {
    return this.#inner.load(key)
  }
  async save(key: StorageKey, data: Uint8Array): Promise<void> {
    if (this.#shouldReject(key)) {
      this.rejectionCount++
      throw new Error("simulated storage failure")
    }
    return this.#inner.save(key, data)
  }
  async remove(key: StorageKey): Promise<void> {
    return this.#inner.remove(key)
  }
  async saveBatch(entries: Array<[StorageKey, Uint8Array]>): Promise<void> {
    if (entries.some(([k]) => this.#shouldReject(k))) {
      this.rejectionCount++
      throw new Error("simulated storage failure")
    }
    return this.#inner.saveBatch(entries)
  }
}

async function waitForCondition(
  fn: () => boolean,
  timeoutMs: number,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return
    await new Promise(r => setTimeout(r, intervalMs))
  }
  throw new Error(`waitForCondition timed out after ${timeoutMs}ms`)
}
