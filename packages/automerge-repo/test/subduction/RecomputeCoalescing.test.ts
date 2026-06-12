/**
 * Regression: bulk attach must not trigger one recompute walk per doc.
 *
 * `SubductionSource` used to call the synchronous `#recompute` once per
 * `attach`, and each call walked ALL entries — O(N²) synchronous work on
 * bulk create/find that monopolized the thread and starved the
 * transport's keepalive. `#scheduleRecompute` now coalesces a burst into
 * a single walk on the next macrotask.
 *
 * `#scheduleRecompute` is the only direct caller of `yieldToMacrotask`
 * in the source (`#runRecompute` / `#saveNewCommits` /
 * `#loadBlobsIntoHandle` go through `makeYielder`, whose internal calls
 * resolve against the unmocked module binding). So the number of direct
 * `yieldToMacrotask` calls observed by this mock counts exactly the
 * number of *scheduled recompute walks*:
 *
 *   - a full revert to synchronous per-attach recompute → 0 scheduled
 *     walks → the lower bound fails
 *   - a broken coalescing flag (one walk scheduled per attach) → ≈N
 *     scheduled walks → the upper bound fails
 *
 * Timing is driven with vitest fake timers (installed only after repo
 * construction, following the presence heartbeat-delay test, #670, and
 * the awareness pruning test, #625). `yieldToMacrotask` resolves via
 * `setImmediate` in Node, which fake timers control, and the dummy
 * storage adapter settles on microtasks, which `advanceTimersByTimeAsync`
 * flushes — so the interleaving of walks and save completions is
 * deterministic and the assertions can be exact rather than fuzzy
 * real-time bounds.
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
import { pause } from "../../src/helpers/pause.js"
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
    // Construct with real timers: subduction's async init awaits real I/O.
    const repo = makeRepo()
    await pause(100)

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
    await pause(100)

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
