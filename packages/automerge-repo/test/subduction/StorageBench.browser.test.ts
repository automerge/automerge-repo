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
import {
  CommitId,
  IndexedDbStorage,
  SedimentreeId,
  SignedFragment,
  SignedLooseCommit,
} from "@automerge/automerge-subduction/slim"

import { IndexedDBStorageAdapter } from "../../../automerge-repo-storage-indexeddb/dist/index.js"
// The bridge + its inline codec from built dist (pure JS, no Wasm), so the
// micro-benches use exactly what the inlined bridge writes.
import { encodeInline } from "../../dist/subduction/codec.js"
import { SubductionStorageBridge } from "../../dist/subduction/storage.js"
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
declare const __BENCH_TPUT_SCALE__: string
declare const __BENCH_TPUT_BLOB__: string

const parseList = (s: string) =>
  s
    .split(",")
    .map(x => Number(x.trim()))
    .filter(n => n > 0)

const SCALE = parseList(__BENCH_SCALE__)
const REPEATS = Math.max(1, Number(__BENCH_REPEATS__) || 1)
const FIXTURE_PATH = __BENCH_FIXTURE_PATH__
const TPUT_SCALE = parseList(__BENCH_TPUT_SCALE__)
const TPUT_BLOB = Math.max(0, Number(__BENCH_TPUT_BLOB__) || 256)

/** Threshold the inlining work will use; mirrors redb's DEFAULT_INLINE_THRESHOLD. */
const INLINE_THRESHOLD = 16 * 1024

/** Storage namespace + short category codes the bridge writes under; see storage.ts. */
const SUB = "sdn"
const CAT = {
  commits: "c",
  blobs: "b",
  fragments: "f",
  fragmentBlobs: "fb",
} as const

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
    commits: await counting.countByPrefix([SUB, CAT.commits]),
    blobs: await counting.countByPrefix([SUB, CAT.blobs]),
    fragments: await counting.countByPrefix([SUB, CAT.fragments]),
    fragmentBlobs: await counting.countByPrefix([SUB, CAT.fragmentBlobs]),
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

// ── Write throughput (storage-layout micro-bench) ────────────────────
//
// Deterministic, Wasm-free measurement of how fast each storage layout absorbs
// a burst of N logical commits into real IndexedDB, using the bridge's actual
// key shapes, phase structure and inline codec:
//
//   baseline (2 records/commit): saveBatch(N blobs) then saveBatch(N metas)
//   inlined  (1 record/commit):  saveBatch(N inline compound records)
//
// then a final marker write in both. Reports records/sec, MB/sec and — the
// number that matters — logical commits/sec, so the inlining speedup is
// directly visible without the save-throttle noise of the end-to-end path.

type Layout = "baseline" | "inlined"

interface ThroughputResult {
  records: number
  bytes: number
  ms: number
}

const fillBytes = (n: number, seed: number): Uint8Array => {
  const out = new Uint8Array(n)
  let s = seed >>> 0 || 1
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0
    out[i] = s & 0xff
  }
  return out
}

const hex16 = (i: number): string => i.toString(16).padStart(32, "0")

const runThroughput = async (
  n: number,
  layout: Layout,
  blobSize: number
): Promise<ThroughputResult> => {
  const dbName = `bench-tput-${layout}-${n}-${crypto.randomUUID()}`
  const adapter = new IndexedDBStorageAdapter(dbName)
  const sid = "0".repeat(64)
  // ~230 B median signed-commit meta in the real dumps.
  const meta = fillBytes(230, 7)

  const blobEntries: Array<[string[], Uint8Array]> = []
  const metaEntries: Array<[string[], Uint8Array]> = []
  let bytes = 0
  for (let i = 0; i < n; i++) {
    const idHex = hex16(i)
    const blob = fillBytes(blobSize, i + 1)
    if (layout === "inlined") {
      const rec = encodeInline(meta, blob)
      metaEntries.push([[SUB, "commits", sid, idHex], rec])
      bytes += rec.byteLength
    } else {
      blobEntries.push([[SUB, "blobs", sid, idHex], blob])
      metaEntries.push([[SUB, "commits", sid, idHex], meta])
      bytes += blob.byteLength + meta.byteLength
    }
  }
  const marker: [string[], Uint8Array] = [
    [SUB, "ids", sid],
    new Uint8Array([1]),
  ]

  const [, ms] = await timed(async () => {
    if (layout === "baseline") await adapter.saveBatch(blobEntries)
    await adapter.saveBatch(metaEntries)
    await adapter.saveBatch([marker])
  })

  const records = (layout === "baseline" ? 2 * n : n) + 1
  await deleteDatabase(dbName)
  return { records, bytes, ms }
}

describe("storage bench: write throughput", () => {
  test("logical-commit write throughput, baseline vs inlined", async () => {
    await runThroughput(200, "inlined", TPUT_BLOB) // warm up

    // Median over REPEATS sequential runs (parallel runs would contend on
    // IndexedDB and distort the throughput number).
    const medianMs = async (n: number, layout: Layout): Promise<number> => {
      const samples: number[] = []
      for (let r = 0; r < REPEATS; r++) {
        samples.push((await runThroughput(n, layout, TPUT_BLOB)).ms)
      }
      return median(samples)
    }

    for (const n of TPUT_SCALE) {
      const base = await medianMs(n, "baseline")
      const inl = await medianMs(n, "inlined")

      const commitsPerSec = (ms: number) => (n / ms) * 1000
      const speedup = base / inl

      // eslint-disable-next-line no-console
      console.log(
        `[tput n=${String(n).padStart(6)} blob=${TPUT_BLOB}B] ` +
          `baseline=${base.toFixed(0)}ms (${commitsPerSec(base).toFixed(0)} commits/s, ${
            2 * n + 1
          } puts) ` +
          `inlined=${inl.toFixed(0)}ms (${commitsPerSec(inl).toFixed(0)} commits/s, ${
            n + 1
          } puts) ` +
          `=> ${speedup.toFixed(2)}x`
      )

      // Pure measurement — the throughput ratio is browser-dependent
      // (per-record overhead dominates on Firefox/WebKit, where inlining
      // ~halves write time; Chromium is byte-bound, so the gain is smaller or
      // neutral). Only sanity-check that both layouts actually wrote.
      expect(base).toBeGreaterThan(0)
      expect(inl).toBeGreaterThan(0)
    }
  }, 600_000)
})

// ── Backend comparison: JS bridge vs wasm IndexedDbStorage ───────────
//
// The Subduction Wasm package ships its own `IndexedDbStorage` backend (native
// compound storage, single IDB transaction per batch). This replays IDENTICAL
// real commits from a fixture into both `saveBatchAll(sid, commits, [])`
// implementations and compares write throughput, isolating the storage backend
// (no signing / minimize_tree). Gated on BENCH_FIXTURE.

const hexToBytes = (hex: string): Uint8Array =>
  Uint8Array.from({ length: hex.length / 2 }, (_, i) =>
    parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  )

interface SidInputs {
  sid: InstanceType<typeof SedimentreeId>
  commits: Array<{
    commitId: InstanceType<typeof CommitId>
    signedCommit: InstanceType<typeof SignedLooseCommit>
    blob: Uint8Array
  }>
  fragments: Array<{
    fragmentHead: InstanceType<typeof CommitId>
    signedFragment: InstanceType<typeof SignedFragment>
    blob: Uint8Array
  }>
}

maybeDescribe("storage backend: JS bridge vs wasm IndexedDbStorage", () => {
  test("write throughput replaying identical real commits", async () => {
    const res = await fetch(`/@fs${FIXTURE_PATH}`)
    const fixture = (await res.json()) as Fixture

    // Group fixture records by sedimentree id, joining meta<->blob by id.
    type Half = { meta?: Uint8Array; blob?: Uint8Array }
    const sids = new Map<
      string,
      { commits: Map<string, Half>; fragments: Map<string, Half> }
    >()
    const slot = (sidHex: string) => {
      let s = sids.get(sidHex)
      if (!s) {
        s = { commits: new Map(), fragments: new Map() }
        sids.set(sidHex, s)
      }
      return s
    }
    for (const r of fixture.records) {
      const [, cat, sidHex, idHex] = r.key
      if (!sidHex || !idHex) continue
      const bytes = b64ToBytes(r.data)
      const s = slot(sidHex)
      const into = (m: Map<string, Half>, k: "meta" | "blob") => {
        const h = m.get(idHex) ?? {}
        h[k] = bytes
        m.set(idHex, h)
      }
      if (cat === "commits") into(s.commits, "meta")
      else if (cat === "blobs") into(s.commits, "blob")
      else if (cat === "fragments") into(s.fragments, "meta")
      else if (cat === "fragment-blobs") into(s.fragments, "blob")
    }

    // Reconstruct Wasm input objects once (outside the timed region), so the
    // measurement is storage I/O, not decode cost. Reused for both backends
    // (saveBatchAll borrows; it does not consume).
    const inputs: SidInputs[] = []
    let totalCommits = 0
    let totalFragments = 0
    for (const [sidHex, s] of sids) {
      const sid = SedimentreeId.fromBytes(hexToBytes(sidHex))
      const commits: SidInputs["commits"] = []
      for (const [idHex, h] of s.commits) {
        if (!h.meta || !h.blob) continue
        commits.push({
          commitId: CommitId.fromBytes(hexToBytes(idHex)),
          signedCommit: SignedLooseCommit.tryDecode(h.meta),
          blob: h.blob,
        })
      }
      const fragments: SidInputs["fragments"] = []
      for (const [idHex, h] of s.fragments) {
        if (!h.meta || !h.blob) continue
        fragments.push({
          fragmentHead: CommitId.fromBytes(hexToBytes(idHex)),
          signedFragment: SignedFragment.tryDecode(h.meta),
          blob: h.blob,
        })
      }
      if (commits.length || fragments.length) {
        inputs.push({ sid, commits, fragments })
        totalCommits += commits.length
        totalFragments += fragments.length
      }
    }

    // JS bridge (our inlined SubductionStorageBridge over IndexedDBStorageAdapter).
    const jsDb = `bench-backend-js-${crypto.randomUUID()}`
    const jsBridge = new SubductionStorageBridge(
      new IndexedDBStorageAdapter(jsDb)
    )
    const [, jsMs] = await timed(async () => {
      for (const { sid, commits, fragments } of inputs) {
        await jsBridge.saveBatchAll(sid, commits, fragments)
      }
    })
    await deleteDatabase(jsDb)

    // Wasm-native IndexedDbStorage (compound storage, one txn per batch).
    const wasmDb = `bench-backend-wasm-${crypto.randomUUID()}`
    const wasmStore = await IndexedDbStorage.setup(indexedDB, wasmDb)
    const [, wasmMs] = await timed(async () => {
      for (const { sid, commits, fragments } of inputs) {
        await wasmStore.saveBatchAll(sid, commits, fragments)
        await wasmStore.saveSedimentreeId(sid)
      }
    })
    wasmStore.free?.()
    await deleteDatabase(wasmDb)

    const cps = (ms: number) => (totalCommits / ms) * 1000
    // eslint-disable-next-line no-console
    console.log(
      `[backend ${fixture.source}] sids=${inputs.length} ` +
        `commits=${totalCommits} fragments=${totalFragments} | ` +
        `JS bridge=${jsMs.toFixed(0)}ms (${cps(jsMs).toFixed(0)} commits/s) ` +
        `wasm IndexedDbStorage=${wasmMs.toFixed(0)}ms (${cps(wasmMs).toFixed(0)} commits/s) ` +
        `=> wasm ${(jsMs / wasmMs).toFixed(2)}x JS`
    )

    expect(totalCommits).toBeGreaterThan(0)
  }, 600_000)
})

// ── Key-scheme micro-bench (write/read cost vs key size) ─────────────
//
// Holds the payload constant (inline compound value) and varies only the KEY
// shape, writing N records straight to a raw IndexedDB object store:
//
//   current : ["subduction-v2","commits", 64-hex sid, 64-hex id]  value {key,binary}
//   t1      : ["sdn","c", base64url(sid), base64url(id)]           value {key,binary}
//   t3      : ArrayBuffer(tag ++ sidBytes ++ idBytes)              value raw Uint8Array
//
// `current`/`t1` keep StorageKey = string[] (bridge-local change); `t3` is a
// reference ceiling for a future binary-key store. Reports per engine so the
// effect is visible everywhere (Chromium is byte-bound; FF/WebKit less so).

type KeyScheme = "current" | "t1" | "t3"

const b64url = (b: Uint8Array): string => {
  let s = ""
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}
const hexOf = (b: Uint8Array): string =>
  Array.from(b, x => x.toString(16).padStart(2, "0")).join("")

const openDb = (name: string): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1)
    req.onupgradeneeded = () => req.result.createObjectStore("s")
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })

const buildKeyValue = (
  scheme: KeyScheme,
  sidBytes: Uint8Array,
  idBytes: Uint8Array,
  payload: Uint8Array
): [IDBValidKey, unknown, number] => {
  if (scheme === "t3") {
    const k = new Uint8Array(1 + 32 + 32)
    k[0] = 0
    k.set(sidBytes, 1)
    k.set(idBytes, 33)
    return [k, payload, k.byteLength]
  }
  const key =
    scheme === "current"
      ? ["subduction-v2", "commits", hexOf(sidBytes), hexOf(idBytes)]
      : ["sdn", "c", b64url(sidBytes), b64url(idBytes)]
  const keyChars = key.reduce((n, s) => n + s.length, 0)
  return [key, { key, binary: payload }, keyChars]
}

const runKeyScheme = async (
  n: number,
  scheme: KeyScheme,
  blobSize: number
): Promise<{ writeMs: number; readMs: number; keySize: number }> => {
  const dbName = `bench-key-${scheme}-${crypto.randomUUID()}`
  const db = await openDb(dbName)
  const sidBytes = fillBytes(32, 99)
  const meta = fillBytes(230, 7)
  const pairs: Array<[IDBValidKey, unknown]> = []
  let keySize = 0
  for (let i = 0; i < n; i++) {
    const payload = encodeInline(meta, fillBytes(blobSize, i + 1))
    const [k, v, ks] = buildKeyValue(
      scheme,
      sidBytes,
      fillBytes(32, i + 1),
      payload
    )
    pairs.push([k, v])
    keySize = ks
  }

  const [, writeMs] = await timed(
    () =>
      new Promise<void>((res, rej) => {
        const tx = db.transaction("s", "readwrite")
        const os = tx.objectStore("s")
        for (const [k, v] of pairs) os.put(v, k)
        tx.oncomplete = () => res()
        tx.onerror = () => rej(tx.error)
      })
  )

  const [, readMs] = await timed(
    () =>
      new Promise<void>((res, rej) => {
        const tx = db.transaction("s")
        const os = tx.objectStore("s")
        os.getAll()
        os.getAllKeys()
        tx.oncomplete = () => res()
        tx.onerror = () => rej(tx.error)
      })
  )

  db.close()
  await deleteDatabase(dbName)
  return { writeMs, readMs, keySize }
}

describe("storage bench: key scheme (write/read vs key size)", () => {
  test("current hex vs t1 short+base64url vs t3 binary single-key", async () => {
    await runKeyScheme(200, "t1", TPUT_BLOB) // warm up

    const schemes: KeyScheme[] = ["current", "t1", "t3"]
    for (const n of TPUT_SCALE) {
      const out: string[] = []
      let baseWrite = 0
      for (const scheme of schemes) {
        const writes: number[] = []
        const reads: number[] = []
        let keySize = 0
        for (let r = 0; r < REPEATS; r++) {
          const s = await runKeyScheme(n, scheme, TPUT_BLOB)
          writes.push(s.writeMs)
          reads.push(s.readMs)
          keySize = s.keySize
        }
        const w = median(writes)
        const rd = median(reads)
        if (scheme === "current") baseWrite = w
        const wps = ((n / w) * 1000).toFixed(0)
        const speed = baseWrite ? (baseWrite / w).toFixed(2) : "1.00"
        out.push(
          `${scheme}(key~${keySize}${scheme === "t3" ? "B" : "ch"}): ` +
            `write=${w.toFixed(0)}ms (${wps}/s, ${speed}x) read=${rd.toFixed(0)}ms`
        )
      }
      // eslint-disable-next-line no-console
      console.log(
        `[keyscheme n=${String(n).padStart(6)} blob=${TPUT_BLOB}B] ${out.join(" | ")}`
      )
    }

    expect(TPUT_SCALE.length).toBeGreaterThan(0)
  }, 600_000)
})

// ── Off-main-thread bench (Worker IDB under main-thread contention) ──
//
// Tests the claim that moving IDB to a Worker helps EFFECTIVE throughput when
// the main thread is contended (React/Automerge), not in an idle bench. A
// contention loop burns CPU on the main thread (simulating render frames) while
// we write the same workload (a) on the main thread and (b) in a Worker. IDB
// callbacks on the main thread queue behind the bursts; the Worker's run on its
// own thread. Compares: main(idle) vs main(contended) vs worker(main contended).

/** Burn ~`burstMs` of CPU every ~`gapMs` on the main thread until stopped. */
const startContention = (burstMs = 4, gapMs = 2): (() => void) => {
  let stopped = false
  const tick = () => {
    if (stopped) return
    const end = performance.now() + burstMs
    while (performance.now() < end) {
      /* busy-wait, hogging the main thread */
    }
    setTimeout(tick, gapMs)
  }
  setTimeout(tick, gapMs)
  return () => {
    stopped = true
  }
}

const mainThreadWrite = async (
  n: number,
  perTxn: number,
  blobSize: number
): Promise<number> => {
  const dbName = `bench-main-${crypto.randomUUID()}`
  const db = await openDb(dbName)
  const meta = fillBytes(230, 7)
  const t0 = performance.now()
  let id = 0
  while (id < n) {
    await new Promise<void>((res, rej) => {
      const tx = db.transaction("s", "readwrite")
      const os = tx.objectStore("s")
      for (let r = 0; r < perTxn && id < n; r++) {
        id++
        const key = [SUB, CAT.commits, "sid", "id" + id]
        os.put(
          { key, binary: encodeInline(meta, fillBytes(blobSize, id)) },
          key
        )
      }
      tx.oncomplete = () => res()
      tx.onerror = () => rej(tx.error)
    })
  }
  const ms = performance.now() - t0
  db.close()
  await deleteDatabase(dbName)
  return ms
}

describe("storage bench: off-main-thread (worker) under contention", () => {
  test("main vs worker IDB while the main thread is busy", async () => {
    const n = 3000
    const perTxn = 10
    const blob = 480

    const worker = new Worker(
      new URL("./_storage-bench-worker.ts", import.meta.url),
      { type: "module" }
    )
    const runWorker = (msg: {
      n: number
      perTxn: number
      blobSize: number
    }): Promise<number> =>
      new Promise((resolve, reject) => {
        worker.onmessage = ev => resolve((ev.data as { ms: number }).ms)
        worker.onerror = err => reject(err)
        worker.postMessage(msg)
      })

    // Warm up both paths (JIT, IDB open) before measuring.
    await mainThreadWrite(200, perTxn, blob)
    await runWorker({ n: 200, perTxn, blobSize: blob })

    const baseMain = await mainThreadWrite(n, perTxn, blob)

    const s1 = startContention()
    const contendedMain = await mainThreadWrite(n, perTxn, blob)
    s1()

    const workerIdle = await runWorker({ n, perTxn, blobSize: blob })

    const s2 = startContention()
    const workerContended = await runWorker({ n, perTxn, blobSize: blob })
    s2()
    worker.terminate()

    // eslint-disable-next-line no-console
    console.log(
      `[worker n=${n} perTxn=${perTxn}] ` +
        `main(idle)=${baseMain.toFixed(0)}ms ` +
        `main(contended)=${contendedMain.toFixed(0)}ms ` +
        `worker(idle)=${workerIdle.toFixed(0)}ms ` +
        `worker(main contended)=${workerContended.toFixed(0)}ms | ` +
        `contention slows main ${(contendedMain / baseMain).toFixed(2)}x, ` +
        `worker resists contention ${(workerContended / workerIdle).toFixed(2)}x, ` +
        `worker vs contended-main ${(contendedMain / workerContended).toFixed(2)}x`
    )

    expect(workerContended).toBeGreaterThan(0)
  }, 600_000)
})
