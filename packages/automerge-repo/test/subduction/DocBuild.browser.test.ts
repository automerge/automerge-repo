/**
 * Off-main-thread doc-building bench.
 *
 * Subduction's cold-load path applies a sedimentree's merged blob bytes to an
 * Automerge doc via `Automerge.loadIncremental(doc, merged)` on the MAIN thread
 * (`source.ts` `#loadBlobsIntoHandle`) — heavy, UI-blocking wasm work. This
 * measures doing that build in a Worker instead: the worker materialises the
 * doc and `save`s a compact snapshot; the main thread only `load`s the snapshot.
 *
 * Reports, per engine: main-thread build time (fully blocking) vs the worker
 * path's worker-compute time (off-thread) and the residual main-thread `load`
 * of the snapshot (the only main-thread block in the worker path).
 *
 * Gated: not part of `pnpm test`. Run via the browser bench config.
 */
import { describe, expect, test } from "vitest"
import { next as A } from "@automerge/automerge"
import {
  DocBuildCancelledError,
  DocBuildWorkerClient,
} from "../../dist/subduction/DocBuildWorkerClient.js"
import {
  subductionTimings,
  TimingCollector,
} from "../../dist/subduction/timing.js"

declare const __BENCH_REPEATS__: string
const REPEATS = Math.max(1, Number(__BENCH_REPEATS__) || 1)

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

const mergeArrays = (arrs: Uint8Array[]): Uint8Array => {
  const total = arrs.reduce((n, a) => n + a.byteLength, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const a of arrs) {
    out.set(a, o)
    o += a.byteLength
  }
  return out
}

/** Build a doc of `n` single-key changes; return the concatenated change log. */
const makeMerged = (n: number): { merged: Uint8Array; changes: number } => {
  let doc = A.init<Record<string, number>>()
  const changes: Uint8Array[] = []
  for (let i = 0; i < n; i++) {
    doc = A.change(doc, d => {
      d["k" + i] = i
    })
    const c = A.getLastLocalChange(doc)
    if (c) changes.push(c)
  }
  return { merged: mergeArrays(changes), changes: changes.length }
}

const mainBuildMs = (merged: Uint8Array): number => {
  const t0 = performance.now()
  A.loadIncremental(A.init(), merged)
  return performance.now() - t0
}

describe("doc-build worker: correctness", () => {
  test("DocBuildWorkerClient snapshot reconstructs the same doc as the inline build", async () => {
    const client = new DocBuildWorkerClient()
    try {
      for (const n of [200, 2000]) {
        const { merged } = makeMerged(n)
        const snapshot = await client.build(merged)

        const inline = A.loadIncremental(
          A.init<Record<string, number>>(),
          merged
        )
        const fromSnapshot = A.loadIncremental(
          A.init<Record<string, number>>(),
          snapshot
        )

        // Heads are content-addressed: equal heads ⇒ identical change set.
        expect(A.getHeads(fromSnapshot)).toEqual(A.getHeads(inline))
        // Spot-check materialised values survive the worker round-trip.
        expect(fromSnapshot["k0"]).toBe(0)
        expect(fromSnapshot["k" + (n - 1)]).toBe(n - 1)
      }
    } finally {
      client.dispose()
    }
  }, 120_000)

  test("pool defaults to 3 workers and demuxes concurrent round-robin builds", async () => {
    const client = new DocBuildWorkerClient()
    expect(client.size).toBe(3)
    try {
      // Fire more concurrent builds than workers (9 > 3) so the round-robin
      // dispatch reuses each worker and the shared #pending map has to
      // demultiplex overlapping responses from all three.
      const sizes = [50, 100, 150, 200, 250, 300, 350, 400, 450]
      const cases = sizes.map(n => makeMerged(n))
      const snapshots = await Promise.all(
        cases.map(c => client.build(c.merged))
      )

      snapshots.forEach((snapshot, i) => {
        const n = sizes[i]
        const inline = A.loadIncremental(
          A.init<Record<string, number>>(),
          cases[i].merged
        )
        const fromSnapshot = A.loadIncremental(
          A.init<Record<string, number>>(),
          snapshot
        )
        expect(A.getHeads(fromSnapshot)).toEqual(A.getHeads(inline))
        // Each snapshot must be the RIGHT doc (no cross-worker id mixups).
        expect(fromSnapshot["k" + (n - 1)]).toBe(n - 1)
      })
    } finally {
      client.dispose()
    }
  }, 120_000)

  test("respects an explicit pool size", () => {
    const client = new DocBuildWorkerClient({ poolSize: 2 })
    try {
      expect(client.size).toBe(2)
    } finally {
      client.dispose()
    }
  })
})

describe("doc-build worker: timing + failures", () => {
  test("records ok round-trips with build/save split", async () => {
    subductionTimings.clear().enable()
    const client = new DocBuildWorkerClient({ poolSize: 2 })
    try {
      const { merged } = makeMerged(500)
      await client.build(merged)
      const rtt = subductionTimings.records.filter(
        r => r.phase === "worker-rtt"
      )
      expect(rtt.length).toBe(1)
      expect(rtt[0].outcome).toBe("ok")
      expect(rtt[0].worker).toBeTypeOf("number")
      expect(rtt[0].bytes).toBe(merged.byteLength)
      expect(rtt[0].extra?.buildMs).toBeGreaterThanOrEqual(0)
      expect(rtt[0].extra?.saveMs).toBeGreaterThanOrEqual(0)
      expect(rtt[0].extra?.queueMs).toBeGreaterThanOrEqual(0)
    } finally {
      client.dispose()
      subductionTimings.disable().clear()
    }
  }, 60_000)

  test("records a failed build (garbage input) and rejects", async () => {
    subductionTimings.clear().enable()
    const client = new DocBuildWorkerClient({ poolSize: 1 })
    try {
      // Not a valid Automerge chunk → loadIncremental throws in the worker.
      const garbage = new Uint8Array(128).map((_, i) => (i * 37 + 7) % 256)
      await expect(client.build(garbage)).rejects.toBeInstanceOf(Error)
      const failed = subductionTimings.failures.filter(
        r => r.phase === "worker-rtt" && r.outcome === "failed"
      )
      expect(failed.length).toBe(1)
      expect(failed[0].error).toBeTruthy()
      expect(failed[0].ms).toBeGreaterThanOrEqual(0)
    } finally {
      client.dispose()
      subductionTimings.disable().clear()
    }
  }, 60_000)

  test("records cancelled builds when the pool is disposed mid-flight", async () => {
    subductionTimings.clear().enable()
    const client = new DocBuildWorkerClient({ poolSize: 1 })
    const { merged } = makeMerged(4000)
    // Dispatch synchronously, then dispose before any response can arrive.
    const p1 = client.build(merged)
    const p2 = client.build(merged)
    expect(client.inFlight).toBe(2)
    client.dispose()

    await expect(p1).rejects.toBeInstanceOf(DocBuildCancelledError)
    await expect(p2).rejects.toBeInstanceOf(DocBuildCancelledError)
    const cancelled = subductionTimings.failures.filter(
      r => r.outcome === "cancelled"
    )
    expect(cancelled.length).toBe(2)
    expect(cancelled[0].error).toBe("pool disposed")
    subductionTimings.disable().clear()
  }, 60_000)

  test("collectAll merges another thread's records over BroadcastChannel", async () => {
    // Two collectors stand in for two threads; same-origin BroadcastChannel
    // instances deliver to each other even within one page.
    const a = new TimingCollector()
    const b = new TimingCollector()
    a.source = "test-A"
    b.source = "test-B"
    a.clear().enable()
    b.clear().enable()
    subductionTimings.clear() // keep the module singleton from adding noise
    try {
      a.record({
        ts: 1,
        phase: "cold-load",
        outcome: "ok",
        ms: 10,
        sid: "aaaa",
      })
      b.record({
        ts: 2,
        phase: "cold-load",
        outcome: "ok",
        ms: 20,
        sid: "bbbb",
      })

      const merged = await a.collectAll(300)
      const sids = merged.map(r => r.sid)
      expect(sids).toContain("aaaa") // a's own record
      expect(sids).toContain("bbbb") // b's record, pulled cross-thread
      const sources = new Set(merged.map(r => r.source))
      expect(sources.has("test-A")).toBe(true)
      expect(sources.has("test-B")).toBe(true)
    } finally {
      a.close()
      b.close()
    }
  }, 60_000)

  test("summary() tallies ok/failed/cancelled per phase", () => {
    subductionTimings.clear().enable()
    subductionTimings.record({
      ts: 0,
      phase: "worker-rtt",
      outcome: "ok",
      ms: 10,
    })
    subductionTimings.record({
      ts: 1,
      phase: "worker-rtt",
      outcome: "failed",
      ms: 5,
    })
    subductionTimings.record({
      ts: 2,
      phase: "worker-rtt",
      outcome: "cancelled",
      ms: 1,
    })
    const s = subductionTimings.summary()["worker-rtt"]
    expect(s.n).toBe(3)
    expect(s.ok).toBe(1)
    expect(s.failed).toBe(1)
    expect(s.cancelled).toBe(1)
    expect(subductionTimings.failures.length).toBe(2)
    expect(subductionTimings.csv().split("\n").length).toBe(4) // header + 3
    subductionTimings.disable().clear()
  })
})

describe("doc-build bench: main thread vs worker", () => {
  test("loadIncremental on the main thread vs in a Worker", async () => {
    const worker = new Worker(
      new URL("./_doc-build-worker.ts", import.meta.url),
      { type: "module" }
    )
    const runWorker = (
      merged: Uint8Array
    ): Promise<{ snapshot: Uint8Array; computeMs: number; wallMs: number }> =>
      new Promise((resolve, reject) => {
        const t0 = performance.now()
        const timer = setTimeout(
          () => reject(new Error("worker timed out after 20s")),
          20_000
        )
        worker.onmessage = ev => {
          clearTimeout(timer)
          resolve({
            snapshot: (ev.data as { snapshot: Uint8Array }).snapshot,
            computeMs: (ev.data as { ms: number }).ms,
            wallMs: performance.now() - t0,
          })
        }
        worker.onerror = err => {
          clearTimeout(timer)
          // eslint-disable-next-line no-console
          console.log("worker.onerror:", err.message ?? String(err))
          reject(err instanceof Error ? err : new Error(String(err)))
        }
        const copy = merged.slice() // transfer a copy; keep `merged` for main build
        worker.postMessage({ merged: copy }, [copy.buffer])
      })

    // Warm up both paths (wasm init, JIT).
    {
      // eslint-disable-next-line no-console
      console.log("docbuild: making merged…")
      const { merged } = makeMerged(200)
      // eslint-disable-next-line no-console
      console.log("docbuild: main build…")
      mainBuildMs(merged)
      // eslint-disable-next-line no-console
      console.log("docbuild: awaiting worker…")
      await runWorker(merged)
      // eslint-disable-next-line no-console
      console.log("docbuild: worker warmup done")
    }

    for (const n of [2000, 5000, 10000]) {
      const { merged, changes } = makeMerged(n)

      const mainMs = median(
        Array.from({ length: REPEATS }, () => mainBuildMs(merged))
      )

      const w = await runWorker(merged)
      const t0 = performance.now()
      A.load(w.snapshot)
      const mainLoadMs = performance.now() - t0

      // eslint-disable-next-line no-console
      console.log(
        `[docbuild changes=${String(changes).padStart(5)} ` +
          `merged=${(merged.byteLength / 1024).toFixed(0)}KB] ` +
          `main build (BLOCKS)=${mainMs.toFixed(0)}ms | ` +
          `worker: compute(off-thread)=${w.computeMs.toFixed(0)}ms ` +
          `wall=${w.wallMs.toFixed(0)}ms ` +
          `snapshot=${(w.snapshot.byteLength / 1024).toFixed(0)}KB ` +
          `main load snapshot (BLOCKS)=${mainLoadMs.toFixed(0)}ms => ` +
          `main-thread block ${(mainMs / mainLoadMs).toFixed(1)}× less`
      )

      expect(mainMs).toBeGreaterThan(0)
    }

    worker.terminate()
  }, 600_000)
})
