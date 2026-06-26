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
import { DocBuildWorkerClient } from "../../dist/subduction/DocBuildWorkerClient.js"

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
