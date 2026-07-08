/**
 * Regression: a bulk attach must not trigger one recompute walk per doc.
 * `#scheduleRecompute` coalesces a burst into a single macrotask walk;
 * the un-coalesced path walked every entry per attach — O(N²) work that
 * starved the transport keepalive.
 *
 * The test counts scheduled walks by mocking `yieldToMacrotask`, of which
 * `#scheduleRecompute` is the only direct caller (the yielders in
 * `#runRecompute` / `#saveNewCommits` / `#loadBlobsIntoHandle` go through
 * `makeYielder`, which closes over the unmocked binding). So the mock's
 * call count equals the number of scheduled walks:
 *   - synchronous per-attach recompute → 0 → lower bound fails
 *   - broken coalescing flag (one walk per attach) → ≈N → upper bound fails
 *
 * Fake timers (installed after repo construction, per #670 / #625) make
 * the walk/save interleaving deterministic: `yieldToMacrotask` resolves
 * via `setImmediate` and the dummy adapter settles on microtasks, both
 * driven by `advanceTimersByTimeAsync`.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

const counter = vi.hoisted(() => ({ scheduledWalks: 0 }))

vi.mock("../../src/helpers/yield.js", async importOriginal => {
  const actual =
    await importOriginal<typeof import("../../src/helpers/yield.js")>()
  return {
    ...actual,
    yieldToMacrotask: () => {
      counter.scheduledWalks++
      return actual.yieldToMacrotask()
    },
  }
})

import { Repo } from "../../src/Repo.js"
import { DummyStorageAdapter } from "../../src/helpers/DummyStorageAdapter.js"
import { initSubduction } from "../../src/initSubduction.js"
import type { PeerId } from "../../src/types.js"

beforeAll(async () => {
  await initSubduction()
})

describe("SubductionSource recompute coalescing", () => {
  const repos: Repo[] = []

  afterEach(async () => {
    // Tests restore real timers in their `finally`, but make sure of it
    // before shutdown in case an assertion threw mid-setup.
    vi.useRealTimers()
    for (const repo of repos) {
      await repo.shutdown()
    }
    repos.length = 0
  })

  const makeRepo = (): Repo => {
    const repo = new Repo({
      peerId: "coalescing-test" as PeerId,
      storage: new DummyStorageAdapter(),
      // Offline on purpose: no endpoints, so the only recompute triggers
      // are attach and storage events, not network traffic.
    })
    repos.push(repo)
    return repo
  }

  /**
   * Drain all scheduled macrotasks, the microtasks they enqueue, and any
   * follow-up walks those schedule (storage saves land on microtasks; the
   * 100ms save throttle and walk scheduling land on fake-controlled
   * timers/immediates). 1s of fake time is far past every delay involved,
   * and costs nothing in real time.
   */
  const flushFake = async () => {
    await vi.advanceTimersByTimeAsync(1_000)
  }

  it("coalesces a synchronous burst of attaches into O(1) walks", async () => {
    // Await subduction's ready promise (the API's init signal) before
    // installing fake timers, rather than guessing with a fixed sleep.
    const repo = makeRepo()
    await repo.subduction

    vi.useFakeTimers()
    try {
      const before = counter.scheduledWalks

      // Synchronous burst: no awaits between creates, so every attach lands
      // before the deferred walk runs.
      const N = 50
      for (let i = 0; i < N; i++) {
        repo.create<{ n: number }>()
      }

      await flushFake()
      const delta = counter.scheduledWalks - before

      // Exactly 3 under fake timers: the burst's single coalesced walk,
      // plus two follow-up walks scheduled as that walk's storage saves
      // and the save throttle settle. The exact constant may shift by a
      // small amount if scheduling around saves intentionally changes —
      // update it then. The regression signals are:
      //   0  → revert to synchronous per-attach recompute
      //   ≈N → broken coalescing flag (one walk per attach)
      expect(delta).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it("schedules a fresh walk for requests arriving after a walk completed", async () => {
    const repo = makeRepo()
    await repo.subduction

    vi.useFakeTimers()
    try {
      repo.create<{ n: number }>()
      await flushFake()

      // The coalescing flag must reset once the walk runs: a later attach
      // gets its own walk rather than being silently dropped.
      const before = counter.scheduledWalks
      repo.create<{ n: number }>()
      await flushFake()

      expect(counter.scheduledWalks - before).toBeGreaterThanOrEqual(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
