/**
 * Gated real-browser bench: `IndexedDBStorageAdapter` (in-thread) vs
 * `IndexedDBWorkerStorageAdapter` (worker). See `vitest.browser.config.ts`.
 *
 * Per variant (median of BENCH_REPEATS): mainThreadMs (main-thread busy time —
 * the number that matters), wallMs, maxBlockMs.
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
declare const __BENCH_BATCH__: string

const RECORDS = Number.parseInt(__BENCH_RECORDS__, 10)
const BLOB = Number.parseInt(__BENCH_BLOB__, 10)
const REPEATS = Number.parseInt(__BENCH_REPEATS__, 10)
const CONTENTION_MS = Number.parseInt(__BENCH_CONTENTION_MS__, 10)
const BATCH = Number.parseInt(__BENCH_BATCH__, 10)

type DisposableAdapter = StorageAdapterInterface

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
    mainThreadMs: Math.round(median(runs.map(r => r.mainThreadMs))),
    wallMs: Math.round(median(runs.map(r => r.wallMs))),
    maxBlockMs: Math.round(median(runs.map(r => r.maxBlockMs))),
  }
}

type Summary = ReturnType<typeof summarize>

// console.table doesn't forward from the browser; ratio is in-thread/worker.
function report(title: string, results: Summary[]) {
  const ratio = (a: number, b: number) =>
    b === 0 ? "n/a" : `${(a / b).toFixed(2)}x`
  const inThread = results.find(r => r.variant === "in-thread")
  const worker = results.find(r => r.variant === "worker")
  const col = (s: string | number, w: number) => String(s).padStart(w)
  const lines = [
    "",
    `### ${title}`,
    `${"variant".padEnd(11)} ${col("mainThreadMs", 13)} ${col("wallMs", 7)} ${col("maxBlockMs", 11)}`,
    ...results.map(
      r =>
        `${r.variant.padEnd(11)} ${col(r.mainThreadMs, 13)} ${col(r.wallMs, 7)} ${col(r.maxBlockMs, 11)}`
    ),
  ]
  if (inThread && worker) {
    lines.push(
      `worker win (in-thread/worker): mainThread ${ratio(inThread.mainThreadMs, worker.mainThreadMs)}, ` +
        `wall ${ratio(inThread.wallMs, worker.wallMs)}, ` +
        `maxBlock ${ratio(inThread.maxBlockMs, worker.maxBlockMs)}`
    )
  }
  console.log(lines.join("\n"))
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
        // Warm up so we measure steady state, not one-time worker startup.
        await adapter.save(["__warmup__"], new Uint8Array([1]))
        await prepare?.(adapter)
        runs.push(await run(adapter))
      } finally {
        adapter.close?.()
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
    report("write throughput + responsiveness (uncontended)", results)
    expect(results).toHaveLength(2)
  })

  it("cold read (loadRange) + responsiveness (uncontended)", async () => {
    const results = await benchVariant(
      adapter => measure(() => adapter.loadRange(["bench"]).then(() => {})),
      adapter => populate(adapter, data)
    )
    report("cold read (loadRange) + responsiveness (uncontended)", results)
    expect(results).toHaveLength(2)
  })

  it(`write under main-thread contention (${CONTENTION_MS}ms/frame)`, async () => {
    const results = await benchVariant(adapter =>
      measure(() => populate(adapter, data), { contentionMs: CONTENTION_MS })
    )
    report(`write under contention (${CONTENTION_MS}ms/frame)`, results)
    expect(results).toHaveLength(2)
  })
})
