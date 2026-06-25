/**
 * Real-browser storage benchmark for the Subduction storage bridge.
 *
 * Runs against *real* IndexedDB (Chromium / Firefox / WebKit via Playwright),
 * not the `fake-indexeddb` shim. Reports both wall-clock latency and the
 * number of IndexedDB record writes (`put`s) per workload — the write count
 * is the metric the blob-inlining change is trying to roughly halve.
 *
 * Gated: not part of `pnpm test`. Run with:
 *
 *   PLAYWRIGHT_BROWSERS_PATH=/nix/.../playwright-browsers \
 *   BENCH_SCALE=100,1000,5000 BENCH_REPEATS=3 \
 *     pnpm --filter @automerge/automerge-repo exec \
 *     vitest run --config vitest.browser.config.ts StorageBench
 */
import { beforeAll, describe, expect, test } from "vitest"

// Import the built package the way real apps do. Crucially we initialise
// Subduction via the `/slim` `initSync` + base64 Wasm (exactly as the
// `react-remote-heads` example does), NOT via `initSubduction()`. The latter
// dynamically imports the fullfat entry, which the bundler optimizes as a
// second copy of the wasm-bindgen glue — a distinct `CommitId` class — so
// `instanceof` checks across the boundary fail ("expected instance of
// CommitId"). Touching only `/slim` keeps a single, initialised copy.
// Run `pnpm --filter @automerge/automerge-repo build` before benching after
// editing the bridge.
// @ts-expect-error — initSync is exported at runtime but absent from the types
import { initSync as initSubductionWasm } from "@automerge/automerge-subduction/slim"
// @ts-expect-error — wasm-base64 has no type declarations
import { wasmBase64 } from "@automerge/automerge-subduction/wasm-base64"

import { IndexedDBStorageAdapter } from "../../../automerge-repo-storage-indexeddb/dist/index.js"
import { Repo } from "@automerge/automerge-repo"
import {
  CountingStorageAdapter,
  type StorageCounts,
  deleteDatabase,
  median,
  timed,
} from "./_bench-helpers.js"

declare const __BENCH_SCALE__: string
declare const __BENCH_REPEATS__: string
declare const __BENCH_FIXTURE_PATH__: string

const SCALE = __BENCH_SCALE__
  .split(",")
  .map(s => Number(s.trim()))
  .filter(n => n > 0)
const REPEATS = Math.max(1, Number(__BENCH_REPEATS__) || 1)
const FIXTURE_PATH = __BENCH_FIXTURE_PATH__

/** Threshold the inlining work will use; mirrors redb's DEFAULT_INLINE_THRESHOLD. */
const INLINE_THRESHOLD = 16 * 1024

/** Storage namespace the (inlined) bridge writes under; see storage.ts. */
const SUB = "subduction-v2"

interface FinalRecords {
  commits: number
  blobs: number
  fragments: number
  fragmentBlobs: number
  total: number
}

interface SyntheticResult {
  n: number
  mutateMs: number
  flushMs: number
  coldLoadMs: number
  counts: StorageCounts
  final: FinalRecords
}

const subductionPuts = (counts: StorageCounts): number =>
  Object.entries(counts.byCategory)
    .filter(([k]) => k.startsWith(`${SUB}/`))
    .reduce((acc, [, v]) => acc + v.puts, 0)

/**
 * One synthetic run: create a doc, apply `n` single-key mutations, flush,
 * then cold-load it in a fresh Repo over the same IndexedDB database.
 * Write counts cover only the mutate+flush window (doc-creation setup is
 * excluded via `reset()`).
 */
const runSynthetic = async (n: number): Promise<SyntheticResult> => {
  const dbName = `bench-syn-${n}-${crypto.randomUUID()}`
  const counting = new CountingStorageAdapter(
    new IndexedDBStorageAdapter(dbName)
  )

  const repo = new Repo({ storage: counting, network: [] })
  const handle = repo.create<{ items: Record<string, number> }>({ items: {} })
  await handle.whenReady()
  const url = handle.url

  counting.reset()
  const [, mutateMs] = await timed(async () => {
    for (let i = 1; i <= n; i++) {
      handle.change(d => {
        d.items[`k${i}`] = i
      })
    }
  })
  const [, flushMs] = await timed(() => repo.flush())
  const counts = structuredClone(counting.counts)

  // Deterministic final on-disk record counts per category (the metric the
  // inlining change targets: small blobs fold into the commit/fragment record).
  const final: FinalRecords = {
    commits: await counting.countByPrefix([SUB, "commits"]),
    blobs: await counting.countByPrefix([SUB, "blobs"]),
    fragments: await counting.countByPrefix([SUB, "fragments"]),
    fragmentBlobs: await counting.countByPrefix([SUB, "fragment-blobs"]),
    total: 0,
  }
  final.total =
    final.commits + final.blobs + final.fragments + final.fragmentBlobs
  await repo.shutdown()

  const counting2 = new CountingStorageAdapter(
    new IndexedDBStorageAdapter(dbName)
  )
  const repo2 = new Repo({ storage: counting2, network: [] })
  const [, coldLoadMs] = await timed(async () => {
    const h = await repo2.find<{ items: Record<string, number> }>(url)
    await h.whenReady()
  })
  await repo2.shutdown()
  await deleteDatabase(dbName)

  return { n, mutateMs, flushMs, coldLoadMs, counts, final }
}

beforeAll(() => {
  // Importing `@automerge/automerge-repo` (fullfat) already auto-initialised the
  // Automerge Wasm. Initialise the Subduction `/slim` Wasm in place (same copy
  // `Repo` uses) before constructing any Repo.
  initSubductionWasm({
    module: Uint8Array.from(atob(wasmBase64), c => c.charCodeAt(0)),
  })
})

describe("storage bench: synthetic write/flush/cold-load", () => {
  test("mutation-count scaling + IDB write counts", async () => {
    await runSynthetic(10) // warm up Wasm / JIT / IDB

    for (const n of SCALE) {
      const runs: SyntheticResult[] = []
      for (let r = 0; r < REPEATS; r++) runs.push(await runSynthetic(n))

      const last = runs[runs.length - 1]
      const med = (sel: (r: SyntheticResult) => number) =>
        median(runs.map(sel)).toFixed(0)
      const f = last.final

      // eslint-disable-next-line no-console
      console.log(
        `[syn n=${String(n).padStart(5)}] ` +
          `mutate=${med(r => r.mutateMs).padStart(5)}ms ` +
          `flush=${med(r => r.flushMs).padStart(6)}ms ` +
          `coldLoad=${med(r => r.coldLoadMs).padStart(5)}ms | ` +
          `FINAL records: total=${String(f.total).padStart(5)} ` +
          `commits=${f.commits} blobs=${f.blobs} ` +
          `fragments=${f.fragments} fragBlobs=${f.fragmentBlobs} | ` +
          `subPuts=${subductionPuts(last.counts)} saveBatch=${last.counts.saveBatch}`
      )

      // Meaningful only if the bridge actually persisted data.
      expect(f.commits + f.fragments).toBeGreaterThan(0)
      expect(subductionPuts(last.counts)).toBeGreaterThan(0)
      // Inlined format: this workload's blobs are all small (single-key
      // changes), so every blob folds into its commit/fragment record and the
      // separate blob records are gone. Regression guard for inlining.
      expect(f.blobs).toBe(0)
      expect(f.fragmentBlobs).toBe(0)
    }
  }, 600_000)
})

// ── Real-world fixture replay ────────────────────────────────────────
//
// Populates real IndexedDB from a sanitized Patchwork dump fixture (see
// scripts/dump-to-fixture.mjs) and measures the cold read the bridge does on
// startup, plus the real-world record distribution. Gated on BENCH_FIXTURE.

interface FixtureRecord {
  key: string[]
  data: string // base64
}
interface Fixture {
  source: string
  recordCount: number
  records: FixtureRecord[]
}

const b64ToBytes = (b64: string): Uint8Array =>
  Uint8Array.from(atob(b64), c => c.charCodeAt(0))

const maybeDescribe = FIXTURE_PATH ? describe : describe.skip

maybeDescribe("storage bench: real-world fixture replay", () => {
  test("populate + cold read + projected inline savings", async () => {
    const res = await fetch(`/@fs${FIXTURE_PATH}`)
    if (!res.ok) throw new Error(`could not fetch fixture: ${FIXTURE_PATH}`)
    const fixture = (await res.json()) as Fixture

    const dbName = `bench-replay-${crypto.randomUUID()}`
    const inner = new IndexedDBStorageAdapter(dbName)
    const counting = new CountingStorageAdapter(inner)

    // Decode + categorise. Tally the inline-threshold projection from the
    // real blob sizes: every blob/fragment-blob record <= 16 KiB becomes a
    // saved write once inlined.
    const cat: Record<string, { records: number; bytes: number }> = {}
    let inlineableBlobs = 0
    let blobRecords = 0
    const decoded: Array<[string[], Uint8Array]> = []
    for (const r of fixture.records) {
      const bytes = b64ToBytes(r.data)
      decoded.push([r.key, bytes])
      const c = r.key.slice(0, 2).join("/")
      const e = (cat[c] ??= { records: 0, bytes: 0 })
      e.records++
      e.bytes += bytes.byteLength
      if (c === "subduction/blobs" || c === "subduction/fragment-blobs") {
        blobRecords++
        if (bytes.byteLength <= INLINE_THRESHOLD) inlineableBlobs++
      }
    }

    // Populate IDB in batches (not part of the measured window).
    const [, populateMs] = await timed(async () => {
      for (let i = 0; i < decoded.length; i += 1000) {
        await inner.saveBatch(decoded.slice(i, i + 1000))
      }
    })

    // Cold read: the bridge scans commits+blobs (and fragments+fragment-blobs)
    // on load. Inlining removes the separate blob scans.
    counting.reset()
    const [, baselineReadMs] = await timed(async () => {
      await Promise.all([
        counting.loadRange(["subduction", "commits"]),
        counting.loadRange(["subduction", "blobs"]),
        counting.loadRange(["subduction", "fragments"]),
        counting.loadRange(["subduction", "fragment-blobs"]),
      ])
    })
    const [, inlinedReadMs] = await timed(async () => {
      await Promise.all([
        counting.loadRange(["subduction", "commits"]),
        counting.loadRange(["subduction", "fragments"]),
      ])
    })

    const totalRecords = fixture.records.length
    const projectedSaved = inlineableBlobs
    const projectedReduction = (100 * projectedSaved) / totalRecords

    // eslint-disable-next-line no-console
    console.log(
      `[replay ${fixture.source}] records=${totalRecords} ` +
        `populate=${populateMs.toFixed(0)}ms | ` +
        `coldRead baseline=${baselineReadMs.toFixed(0)}ms ` +
        `(commits+fragments only=${inlinedReadMs.toFixed(0)}ms) | ` +
        `inlineable blobs<=16KiB=${inlineableBlobs}/${blobRecords} ` +
        `=> projected write reduction ~${projectedReduction.toFixed(1)}% ` +
        `(${totalRecords} -> ${totalRecords - projectedSaved} records)`
    )
    // eslint-disable-next-line no-console
    console.log(`            categories=${JSON.stringify(cat)}`)

    await deleteDatabase(dbName)

    expect(blobRecords).toBeGreaterThan(0)
  }, 600_000)
})
