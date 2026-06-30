/**
 * Real-browser before/after bench: `IndexedDBStorageAdapter` (in-thread) vs
 * `IndexedDBWorkerStorageAdapter` (worker). Gated — runs only under
 * `vitest.browser.config.ts`, never in the default `pnpm test`.
 *
 * Run (NixOS: point PLAYWRIGHT_BROWSERS_PATH at a matching playwright-browsers
 * derivation; the npm-downloaded browsers don't run under the FHS-less env):
 *
 *   PLAYWRIGHT_BROWSERS_PATH=/nix/store/<hash>-playwright-browsers \
 *   BENCH_BROWSERS=chromium,firefox,webkit BENCH_RECORDS=2000 BENCH_BLOB=4096 \
 *     pnpm --filter @automerge/automerge-repo-storage-indexeddb exec \
 *     vitest run --config vitest.browser.config.ts
 *
 * Metrics per variant (median of BENCH_REPEATS):
 *   - wallMs:     wall-clock time for the workload
 *   - maxBlockMs: longest main-thread block (paint stall) — the headline for
 *                 the cold read, where the worker transfers buffers back
 *   - jankMs:     total main-thread blocked-beyond-a-frame time
 * The contended pass adds synthetic main-thread work each frame; there the
 * worker wins on wallMs (storage runs off the contended thread).
 */
import type { StorageAdapterInterface } from "@automerge/automerge-repo/slim"
import { describe, expect, it } from "vitest"

import { IndexedDBStorageAdapter } from "../src/index.js"
import { IndexedDBWorkerStorageAdapter } from "../src/IndexedDBWorkerStorageAdapter.js"
import {
  measure,
  median,
  randomBytes,
  type WorkloadResult,
} from "./_bench-helpers.js"

declare const __BENCH_RECORDS__: string
declare const __BENCH_BLOB__: string
declare const __BENCH_REPEATS__: string
declare const __BENCH_CONTENTION_MS__: string

const RECORDS = Number.parseInt(__BENCH_RECORDS__, 10)
const BLOB = Number.parseInt(__BENCH_BLOB__, 10)
const REPEATS = Number.parseInt(__BENCH_REPEATS__, 10)
const CONTENTION_MS = Number.parseInt(__BENCH_CONTENTION_MS__, 10)
const BATCH = 100

type DisposableAdapter = StorageAdapterInterface & { dispose?(): void }

const dbName = () => "bench-" + Math.random().toString(36).slice(2)

const variants: Array<{ label: string; make: () => DisposableAdapter }> = [
  { label: "in-thread", make: () => new IndexedDBStorageAdapter(dbName()) },
  { label: "worker", make: () => new IndexedDBWorkerStorageAdapter(dbName()) },
]

async function populate(adapter: StorageAdapterInterface, data: Uint8Array) {
  for (let i = 0; i < RECORDS; i += BATCH) {
    const entries: Array<[string[], Uint8Array]> = []
    for (let j = i; j < Math.min(i + BATCH, RECORDS); j++) {
      entries.push([["bench", "doc", String(j)], data.slice()])
    }
    await adapter.saveBatch(entries)
  }
}

function summarize(label: string, runs: WorkloadResult[]) {
  return {
    variant: label,
    wallMs: Math.round(median(runs.map(r => r.wallMs))),
    maxBlockMs: Math.round(median(runs.map(r => r.maxBlockMs))),
    jankMs: Math.round(median(runs.map(r => r.jankMs))),
  }
}

async function benchVariant(
  run: (adapter: DisposableAdapter) => Promise<WorkloadResult>,
  prepare?: (adapter: DisposableAdapter) => Promise<void>
) {
  const results = []
  for (const { label, make } of variants) {
    const runs: WorkloadResult[] = []
    for (let r = 0; r < REPEATS; r++) {
      const adapter = make()
      try {
        await prepare?.(adapter)
        runs.push(await run(adapter))
      } finally {
        adapter.dispose?.()
      }
    }
    results.push(summarize(label, runs))
  }
  return results
}

describe(`IndexedDB worker vs in-thread (records=${RECORDS}, blob=${BLOB}B, repeats=${REPEATS})`, () => {
  const data = randomBytes(BLOB)

  it("write throughput + responsiveness (uncontended)", async () => {
    const results = await benchVariant(adapter =>
      measure(() => populate(adapter, data))
    )
    console.table(results)
    expect(results).toHaveLength(2)
  })

  it("cold read (loadRange) + responsiveness (uncontended)", async () => {
    const results = await benchVariant(
      adapter => measure(() => adapter.loadRange(["bench"]).then(() => {})),
      adapter => populate(adapter, data)
    )
    console.table(results)
    expect(results).toHaveLength(2)
  })

  it(`write under main-thread contention (${CONTENTION_MS}ms/frame)`, async () => {
    const results = await benchVariant(adapter =>
      measure(() => populate(adapter, data), { contentionMs: CONTENTION_MS })
    )
    console.table(results)
    expect(results).toHaveLength(2)
  })
})
