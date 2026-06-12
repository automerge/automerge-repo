/**
 * Behavioral guards for the bulk-attach ("attach storm") fix.
 *
 * `RecomputeCoalescing.test.ts` pins the *mechanism* (a synchronous
 * burst of attaches coalesces into O(1) scheduled walks). This file
 * pins the *observable behavior* that mechanism exists to provide:
 *
 *   1. Always-on: a bulk create of N=200 docs flushes and shuts down
 *      well under the linear baseline. A revert to synchronous
 *      per-attach recompute makes this O(N²) and blows the (very
 *      generous) bound at scale; at N=200 it mainly guards gross
 *      regressions and documents the expectation.
 *
 *   2. RUN_PERF-gated: a sweep across doc counts asserting the
 *      settle phase (create burst + flush) scales sub-quadratically
 *      per doubling, and reporting the longest event-loop stall
 *      during settle. The stall sampler starts *after* the
 *      synchronous create burst: the burst itself is caller code and
 *      inherently one synchronous block; what the yielding fixes is
 *      the *settle* work (recompute walks, saves) that follows.
 *
 * Run the sweep with:
 *
 *   RUN_PERF=1 pnpm --filter @automerge/automerge-repo \
 *     vitest run --no-file-parallelism test/subduction/AttachStorm.test.ts
 */

import { beforeAll, describe, expect, it, test } from "vitest"

import { Repo } from "../../src/Repo.js"
import { DummyStorageAdapter } from "../../src/helpers/DummyStorageAdapter.js"
import { initSubduction } from "../../src/initSubduction.js"

beforeAll(async () => {
  await initSubduction()
})

interface StormTimings {
  burstMs: number
  flushMs: number
  shutdownMs: number
  /** Longest observed event-loop stall during the flush/settle phase. */
  maxStallMs: number
}

/**
 * Sample event-loop responsiveness: a timer that should fire every
 * `intervalMs`; any excess gap between fires is time the loop was
 * blocked by synchronous work.
 */
const startStallSampler = (intervalMs = 10) => {
  let last = performance.now()
  let maxGap = 0
  const timer = setInterval(() => {
    const t = performance.now()
    maxGap = Math.max(maxGap, t - last - intervalMs)
    last = t
  }, intervalMs)
  return () => {
    clearInterval(timer)
    return maxGap
  }
}

/** Create `docCount` docs in one synchronous burst, then settle. */
const measureStorm = async (docCount: number): Promise<StormTimings> => {
  const repo = new Repo({
    storage: new DummyStorageAdapter(),
    // Offline on purpose: the storm is about local attach/recompute
    // work, not network sync.
    network: [],
  })

  try {
    const t0 = performance.now()
    for (let i = 0; i < docCount; i++) {
      repo.create<{ n: number }>({ n: i })
    }
    const tBurst = performance.now()

    const stopSampler = startStallSampler()
    await repo.flush()
    const tFlushed = performance.now()
    const maxStallMs = stopSampler()

    await repo.shutdown()
    const tShutdown = performance.now()

    return {
      burstMs: tBurst - t0,
      flushMs: tFlushed - tBurst,
      shutdownMs: tShutdown - tFlushed,
      maxStallMs,
    }
  } catch (e) {
    try {
      await repo.shutdown()
    } catch {
      /* ignore */
    }
    throw e
  }
}

describe("SubductionSource attach storm", () => {
  it("bulk create of 200 docs flushes and shuts down under the linear baseline", async () => {
    // Always-on guard against re-introducing per-attach O(N²)
    // recompute work. Threshold is generous (~20× a typical run);
    // failures here mean attach or the recompute scheduling grew
    // accidentally quadratic work.
    const N = 200
    const t = await measureStorm(N)

    expect(t.burstMs + t.flushMs + t.shutdownMs).toBeLessThan(10_000)
  }, 30_000)

  it("all docs from a burst are ready and loadable after flush", async () => {
    const repo = new Repo({
      storage: new DummyStorageAdapter(),
      network: [],
    })

    try {
      const N = 100
      const handles = Array.from({ length: N }, (_, i) =>
        repo.create<{ n: number }>({ n: i })
      )

      await repo.flush()

      // Every doc survived the storm: no handle was starved or
      // dropped by the coalesced walks.
      handles.forEach((handle, i) => {
        expect(handle.doc()).toEqual({ n: i })
      })
    } finally {
      await repo.shutdown()
    }
  }, 30_000)
})

// ── RUN_PERF-gated scaling sweep ─────────────────────────────────────

const SHOULD_RUN = process.env.RUN_PERF === "1"
const maybeDescribe = SHOULD_RUN ? describe : describe.skip

const SCALES = process.env.PERF_SCALE
  ? process.env.PERF_SCALE.split(",").map(s => Number(s.trim()))
  : [250, 500, 1000]

maybeDescribe("attach storm sweep", () => {
  test("burst stays linear and flush never starves the event loop", async () => {
    const runs: Array<{ n: number } & StormTimings> = []

    for (const n of SCALES) {
      const t = await measureStorm(n)
      runs.push({ n, ...t })

      const fmt = (ms: number, width = 5) => ms.toFixed(0).padStart(width)
      // eslint-disable-next-line no-console
      console.log(
        `[storm] docs=${String(n).padStart(5)}  ` +
          `burst=${fmt(t.burstMs)}ms  ` +
          `flush=${fmt(t.flushMs)}ms  ` +
          `shutdown=${fmt(t.shutdownMs)}ms  ` +
          `maxStall=${fmt(t.maxStallMs, 4)}ms`
      )

      // The original attach-storm symptom: settle work monopolized the
      // thread for whole seconds, so keepalive pongs starved and the
      // server reaped the connection. With coalesced walks yielding on
      // a 50ms budget, observed stalls are ~0ms; 250ms is generous
      // headroom that still fails on any return to multi-second
      // monopolization.
      expect(t.maxStallMs).toBeLessThan(250)
    }

    // Per-doubling growth. Linear → ~2×, quadratic → ~4×.
    //
    // Burst: what the recompute coalescing fixed (observed ~1.4–2.0×
    // per doubling; per-attach synchronous walks made it ~4×).
    //
    // Flush: was ~3.3–4.3× per doubling until 2026-06-12, from two
    // O(N²) sources — every save/sync completion scheduled a FULL
    // recompute walk (now targeted via the dirty set), and
    // DummyStorageAdapter.loadRange scanned every stored key per call
    // (now first-segment indexed, mirroring the nodefs trie). Observed
    // ~1.9–2.7× per doubling since; 3.5 fails on a return of either
    // quadratic while tolerating the residual per-doc superlinearity.
    for (let i = 1; i < runs.length; i++) {
      const prev = runs[i - 1]
      const cur = runs[i]
      const doublings = Math.log2(cur.n / prev.n)
      if (doublings <= 0) continue

      const burstFactor = (cur.burstMs / prev.burstMs) ** (1 / doublings)
      const flushFactor = (cur.flushMs / prev.flushMs) ** (1 / doublings)

      // eslint-disable-next-line no-console
      console.log(
        `[storm] ${prev.n} → ${cur.n}: ` +
          `burst ${burstFactor.toFixed(2)}× / ` +
          `flush ${flushFactor.toFixed(2)}× per doubling`
      )
      expect(burstFactor).toBeLessThan(3)
      expect(flushFactor).toBeLessThan(3.5)
    }
  }, 300_000)
})
