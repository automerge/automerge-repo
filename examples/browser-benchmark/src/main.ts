import "./style.css"
import { deleteDatabase, saveSeedInfo, seedInfo, storeSize } from "./storage.js"
import { target } from "bench-target"
import type { StorageStats } from "./target.js"

type Fixture = { name: string; sha256: string; bytes: number }
type Manifest = {
  version: number
  count: number
  items: number
  changes: number
  files: Fixture[]
}
type LoadResult = {
  count: number
  totalMs: number
  readyMs: number[]
  frameGapMs: number[]
  longTasksMs: number[]
  p50Ms: number
  p95Ms: number
  p99Ms: number
  maxMs: number
  before: {
    keys: number
    bytes: number
    jsHeapBytes: number | null
    wasmBytes: null
  }
  after: {
    keys: number
    bytes: number
    jsHeapBytes: number | null
    wasmBytes: null
  }
  storeMutated: boolean
}
type Result = {
  schema: 2
  target: { id: string; adapter: string }
  mode: "full" | "smoke" | "custom"
  fixtureSha256: string
  fixture: Omit<Manifest, "files">
  userAgent: string
  timestamp: string
  seed: {
    reused: boolean
    durationMs: number
    database: string
    revision?: string
    storage?: StorageStats
  }
  editDatabase?: string
  loads: LoadResult[]
  edits?: {
    count: number
    callMs: number[]
    durableMs: number[] | null
    frameGapMs: number[]
    longTasksMs: number[]
    drainMs: number | null
    verified: boolean
  }
}
function storageStats(): StorageStats {
  return Object.fromEntries(
    ["load", "save", "list", "remove"].map(name => [
      name,
      { calls: 0, elapsedMs: 0, values: 0 },
    ])
  ) as StorageStats
}

const element = (id: string) => document.getElementById(id)!
const runButton = element("run") as HTMLButtonElement
const downloadButton = element("download") as HTMLButtonElement
const status = element("status")
const bar = element("bar")
const loadRows = element("loads")
const report = element("report")
const fmt = (n: number) => `${n.toFixed(1)} ms`
const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.ceil(p * sorted.length) - 1]
}

let result: Result | undefined
const smoke = new URLSearchParams(location.search).has("smoke")
const reseed = new URLSearchParams(location.search).has("reseed")
const requestedEdits = Number(
  new URLSearchParams(location.search).get("edits") ?? (smoke ? 30 : 5000)
)
if (
  !Number.isSafeInteger(requestedEdits) ||
  requestedEdits < 2 ||
  requestedEdits > 5000
)
  throw new Error("edits must be between 2 and 5000")
const targetName = import.meta.env.VITE_BENCH_NAME ?? target.id
element("target").textContent =
  `TARGET ${targetName} / ${target.adapter} / ${import.meta.env.VITE_BENCH_COMMIT ?? "current worktree"}`
let busy = false
let lastDisplay = 0
function progress(message: string, fraction: number, force = false) {
  bar.style.width = `${Math.round(fraction * 100)}%`
  if (force || performance.now() - lastDisplay > 200) {
    status.textContent = message
    lastDisplay = performance.now()
  }
}

async function sha256(bytes: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest), n =>
    n.toString(16).padStart(2, "0")
  ).join("")
}

async function fixtures(): Promise<{ manifest: Manifest; hash: string }> {
  const response = await fetch("/fixtures/v1/manifest.json", {
    cache: "no-store",
  })
  if (!response.ok)
    throw new Error("Missing fixtures. Run pnpm bench:fixtures first.")
  const bytes = await response.arrayBuffer()
  const manifest = JSON.parse(new TextDecoder().decode(bytes)) as Manifest
  if (
    manifest.version !== 1 ||
    manifest.files.length !== manifest.count ||
    manifest.count < (smoke ? 10 : 1000)
  )
    throw new Error(`Expected at least ${smoke ? 10 : 1000} v1 fixtures`)
  return { manifest, hash: await sha256(bytes) }
}

async function seed(database: string, files: Fixture[], hash: string) {
  const cached = await seedInfo(database)
  if (!reseed && cached) {
    if (cached.hash !== hash || cached.urls.length !== files.length)
      throw new Error(
        "Seed differs from fixtures; run with ?reseed (or automate --reseed)"
      )
    const databases = await indexedDB.databases()
    if (databases.some(entry => entry.name === database)) {
      progress(`Using prepared ${files.length}-document store`, 1, true)
      return {
        urls: cached.urls,
        reused: true,
        durationMs: 0,
        revision: cached.revision,
      }
    }
  }
  const started = performance.now()
  await deleteDatabase(database)
  const stats = storageStats()
  const session = target.open(database, stats)
  const urls: string[] = []
  try {
    for (let start = 0; start < files.length; start += 20) {
      const batch = await Promise.allSettled(
        files.slice(start, start + 20).map(async fixture => {
          const response = await fetch(`/fixtures/v1/${fixture.name}`)
          if (!response.ok) throw new Error(`Failed to fetch ${fixture.name}`)
          const bytes = await response.arrayBuffer()
          if (
            bytes.byteLength !== fixture.bytes ||
            (await sha256(bytes)) !== fixture.sha256
          )
            throw new Error(`Fixture mismatch: ${fixture.name}`)
          return (await session.import(new Uint8Array(bytes))).url
        })
      )
      const failed = batch.find(item => item.status === "rejected")
      if (failed?.status === "rejected") throw failed.reason
      urls.push(
        ...batch.map(item => (item as PromiseFulfilledResult<string>).value)
      )
      progress(
        `Seeding: ${urls.length}/${files.length}`,
        urls.length / files.length
      )
    }
    await session.flush()
  } finally {
    await session.close()
  }
  const revision = import.meta.env.VITE_BENCH_COMMIT ?? "current worktree"
  await saveSeedInfo(database, { hash, urls, revision })
  return {
    urls,
    reused: false,
    durationMs: performance.now() - started,
    revision,
    storage: stats,
  }
}

function memory() {
  const perf = performance as Performance & {
    memory?: { usedJSHeapSize: number }
  }
  return perf.memory?.usedJSHeapSize ?? null
}

async function prepare() {
  const { manifest, hash } = await fixtures()
  const database = `automerge-repo-benchmark-${targetName}-v1-${smoke ? "smoke" : "full"}`
  progress("Preparing documents", 0, true)
  const prepared = await seed(
    database,
    manifest.files.slice(0, smoke ? 10 : 1000),
    hash
  )
  sessionStorage.setItem(
    "benchmark-seed",
    JSON.stringify({
      reused: prepared.reused,
      durationMs: prepared.durationMs,
      database,
      revision: prepared.revision,
      storage: prepared.storage,
    })
  )
  return { reused: prepared.reused }
}

async function load(database: string, urls: string[]): Promise<LoadResult> {
  const sizeBefore = await storeSize(database)
  const before = { ...sizeBefore, jsHeapBytes: memory(), wasmBytes: null }
  const session = target.open(database)
  let sample: LoadResult
  const frameGapMs: number[] = []
  const longTasksMs: number[] = []
  let previousFrame = performance.now()
  let watching = true
  const frame = (time: number) => {
    if (!watching) return
    if (time >= previousFrame) frameGapMs.push(time - previousFrame)
    previousFrame = time
    requestAnimationFrame(frame)
  }
  const observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) longTasksMs.push(entry.duration)
  })
  if (PerformanceObserver.supportedEntryTypes.includes("longtask"))
    observer.observe({ type: "longtask", buffered: false })
  requestAnimationFrame(frame)
  try {
    // No awaits between find calls: all requests enter the same loading wave.
    const start = performance.now()
    let finished = 0
    const readyMs = await Promise.all(
      urls.map((url, i) =>
        session.find<{ count: number }>(url).then(handle => {
          if (handle.doc()?.count !== 50)
            throw new Error(`Incorrect document ${i}`)
          finished++
          progress(
            `Loading ${urls.length}: ${finished}/${urls.length}`,
            finished / urls.length
          )
          return performance.now() - start
        })
      )
    )
    const totalMs = performance.now() - start
    sample = {
      count: urls.length,
      totalMs,
      readyMs,
      p50Ms: percentile(readyMs, 0.5),
      p95Ms: percentile(readyMs, 0.95),
      p99Ms: percentile(readyMs, 0.99),
      maxMs: Math.max(...readyMs),
      frameGapMs,
      longTasksMs,
      before,
      after: before,
      storeMutated: false,
    }
  } finally {
    watching = false
    observer.disconnect()
    await session.close()
  }
  const sizeAfter = await storeSize(database)
  sample.after = { ...sizeAfter, jsHeapBytes: memory(), wasmBytes: null }
  sample.storeMutated =
    sizeBefore.keys !== sizeAfter.keys || sizeBefore.bytes !== sizeAfter.bytes
  return sample
}

async function edits(
  database: string,
  count: number,
  onSamples: (samples: NonNullable<Result["edits"]>) => void
): Promise<NonNullable<Result["edits"]>> {
  await deleteDatabase(database)
  const session = target.open(database)
  const callMs: number[] = []
  const durableMs: number[] = []
  const frameGapMs: number[] = []
  const longTasksMs: number[] = []
  const pending: Promise<void>[] = []
  let firstError: unknown
  let latest = 0
  let previousFrame = 0
  let inflight = 0
  let closed = false
  let timedOut = false
  const observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) longTasksMs.push(entry.duration)
  })
  if (PerformanceObserver.supportedEntryTypes.includes("longtask"))
    observer.observe({ type: "longtask", buffered: false })
  try {
    const handle = await session.create({
      count: 0,
      items: Array(32).fill("initial") as string[],
    })
    handle.on("change", () => {
      latest = handle.doc()?.count ?? 0
      element("document-view").textContent = String(latest)
    })
    for (let i = 1; i <= count; i++) {
      const frame = await new Promise<number>(resolve =>
        requestAnimationFrame(resolve)
      )
      if (previousFrame) frameGapMs.push(frame - previousFrame)
      previousFrame = frame
      const started = performance.now()
      inflight++
      const write = handle.change(
        doc => {
          doc.count = i
          doc.items[i % 32] = `revision-${i}`
        },
        { time: 0 }
      )
      callMs.push(performance.now() - started)
      if (write)
        pending.push(
          write.then(
            () => {
              durableMs[i - 1] = performance.now() - started
              inflight--
            },
            error => {
              firstError ??= error
              inflight--
            }
          )
        )
      else inflight--
      if (i % 10 === 0) {
        progress(`Editing: ${i}/${count}`, i / count)
        if (i % 30 === 0) {
          element("edit").textContent =
            `${i.toLocaleString()} / ${count.toLocaleString()}`
          element("latency").textContent = fmt(callMs[i - 1])
          element("pending").textContent = String(inflight)
          element("frame").textContent = fmt(Math.max(...frameGapMs))
        }
      }
    }
    if (latest !== count) throw new Error(`Change event stopped at ${latest}`)
    progress("Draining persistence", 1, true)
    const drainStart = performance.now()
    const samples = {
      count,
      callMs,
      durableMs: durableMs.length ? durableMs : null,
      frameGapMs,
      longTasksMs,
      drainMs: null,
      verified: false,
    }
    onSamples(samples)
    const drained = await Promise.race([
      Promise.all([session.flush(), Promise.all(pending)]).then(() => true),
      new Promise<false>(resolve => setTimeout(() => resolve(false), 120_000)),
    ])
    if (!drained) {
      timedOut = true
      progress(
        "Persistence drain exceeded 120 seconds; update samples available, not verified",
        1,
        true
      )
      return samples
    }
    if (firstError) throw firstError
    const drainMs = performance.now() - drainStart
    const url = handle.url
    await session.close()
    closed = true
    const reopened = target.open(database)
    try {
      const restored = await reopened.find<{
        count: number
        items: string[]
      }>(url)
      if (
        restored.doc()?.count !== count ||
        restored.doc()?.items[count % 32] !== `revision-${count}`
      )
        throw new Error("Persisted edit verification failed")
    } finally {
      await reopened.close()
    }
    return { ...samples, drainMs, verified: true }
  } finally {
    observer.disconnect()
    if (!closed && !timedOut) await session.close()
  }
}

async function run() {
  if (busy) throw new Error("Benchmark already running")
  busy = true
  result = undefined
  runButton.disabled = true
  downloadButton.disabled = true
  loadRows.replaceChildren()
  report.textContent = "Running…"
  try {
    progress("Reading fixture manifest", 0, true)
    const { manifest, hash } = await fixtures()
    result = {
      schema: 2,
      target: { id: targetName, adapter: target.adapter },
      mode:
        requestedEdits === (smoke ? 30 : 5000)
          ? smoke
            ? "smoke"
            : "full"
          : "custom",
      fixtureSha256: hash,
      fixture: {
        version: manifest.version,
        count: manifest.count,
        items: manifest.items,
        changes: manifest.changes,
      },
      userAgent: navigator.userAgent,
      timestamp: new Date().toISOString(),
      seed: { reused: false, durationMs: 0, database: "" },
      loads: [],
    }
    const database = `automerge-repo-benchmark-${targetName}-v1-${smoke ? "smoke" : "full"}`
    const prepared = await seed(
      database,
      manifest.files.slice(0, smoke ? 10 : 1000),
      hash
    )
    if (!prepared.reused) {
      sessionStorage.setItem("benchmark-resume", "1")
      sessionStorage.setItem(
        "benchmark-seed",
        JSON.stringify({
          reused: false,
          durationMs: prepared.durationMs,
          database,
          revision: prepared.revision,
          storage: prepared.storage,
        })
      )
      const url = new URL(location.href)
      url.searchParams.delete("reseed")
      history.replaceState(null, "", url)
      progress("Prepared; reloading before measurements", 1, true)
      location.reload()
      return undefined
    }
    const preparedSeed = sessionStorage.getItem("benchmark-seed")
    sessionStorage.removeItem("benchmark-seed")
    result.seed = preparedSeed
      ? JSON.parse(preparedSeed)
      : {
          reused: prepared.reused,
          durationMs: prepared.durationMs,
          database,
          revision: prepared.revision,
          storage: prepared.storage,
        }
    for (const count of smoke ? [10] : [10, 100, 500, 1000]) {
      progress(`Loading ${count} documents`, 0, true)
      const sample = await load(database, prepared.urls.slice(0, count))
      result.loads.push(sample)
      const row = document.createElement("tr")
      for (const value of [
        count.toString(),
        fmt(sample.totalMs),
        fmt(sample.p50Ms),
        fmt(sample.p95Ms),
        fmt(sample.p99Ms),
        fmt(sample.maxMs),
      ]) {
        const cell = document.createElement("td")
        cell.textContent = value
        row.append(cell)
      }
      loadRows.append(row)
    }
    progress("Editing new document", 0, true)
    const editDatabase = `automerge-repo-benchmark-${targetName}-v1-edits-${crypto.randomUUID()}`
    result.editDatabase = editDatabase
    result.edits = await edits(editDatabase, requestedEdits, samples => {
      result!.edits = samples
    })
    progress(
      result.edits.verified
        ? "Complete: all states verified"
        : "Incomplete: persistence drain timed out",
      1,
      true
    )
    downloadButton.disabled = false
    report.textContent = JSON.stringify(
      {
        fixtureSha256: hash,
        seed: result.seed,
        loads: result.loads.map(({ readyMs: _readyMs, ...summary }) => summary),
        edits: {
          count: result.edits.count,
          callP95Ms: percentile(result.edits.callMs, 0.95),
          durableP95Ms: result.edits.durableMs
            ? percentile(result.edits.durableMs, 0.95)
            : null,
          worstFrameMs: Math.max(...result.edits.frameGapMs),
          longTasks: result.edits.longTasksMs.length,
          drainMs: result.edits.drainMs,
          verified: result.edits.verified,
        },
      },
      null,
      2
    )
    return result
  } catch (error) {
    progress(`Failed: ${String(error)}`, 0, true)
    report.textContent = String(error)
    result = undefined
    throw error
  } finally {
    runButton.disabled = false
    busy = false
  }
}

if (sessionStorage.getItem("benchmark-resume")) {
  sessionStorage.removeItem("benchmark-resume")
  void run().catch(console.error)
}
runButton.addEventListener("click", () => {
  void run().catch(console.error)
})
downloadButton.addEventListener("click", () => {
  if (!result) return
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(result, null, 2)], { type: "application/json" })
  )
  const link = document.createElement("a")
  link.href = url
  link.download = `repo-browser-benchmark-${result.timestamp.replaceAll(":", "-")}.json`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
})

declare global {
  interface Window {
    benchmark: {
      run: typeof run
      prepare: typeof prepare
      getResult: () => Result | undefined
    }
  }
}
window.benchmark = { run, prepare, getResult: () => result }
