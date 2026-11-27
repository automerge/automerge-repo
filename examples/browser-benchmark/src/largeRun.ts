// Large-document scenarios (`?large`), the browser counterpart of
// `examples/node-benchmark/large.mjs`: each scenario runs in a fresh IndexedDB
// database that is deleted afterwards, and records main-thread stalls.
import { deleteDatabase, storeSize } from "./storage.js"
import type { Target } from "./target.js"
import {
  largeInitial,
  largeLabel,
  largeParts,
  largeSummary,
  type LargeFixture,
  type LargeManifest,
} from "./large.js"

export type LargeSample = {
  scenario: "change" | "import" | "merge" | "edits"
  /** e.g. `records-32`, or `records-saved-32` when sized by saved bytes. */
  fixture: string
  shape: string
  mib: number
  callMs: number | null
  durableMs: number | null
  loadMs: number | null
  /** For `edits`: per-change call latency. */
  callP95Ms?: number
  worstFrameMs: number | null
  longTasksMs: number[]
  storeBytes: number | null
  jsHeapBytes: number | null
  error: string | null
}

export type LargeResult = {
  schema: 1
  mode: "large"
  target: { id: string; adapter: string }
  fixtureSha256: string
  userAgent: string
  timestamp: string
  samples: LargeSample[]
}

async function sha256(bytes: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest), n =>
    n.toString(16).padStart(2, "0")
  ).join("")
}

function memory() {
  const perf = performance as Performance & {
    memory?: { usedJSHeapSize: number }
  }
  return perf.memory?.usedJSHeapSize ?? null
}

/** Frame gaps and long tasks while `work` runs. */
async function observed<T>(work: () => Promise<T>) {
  const gaps: number[] = []
  const longTasksMs: number[] = []
  let active = true
  let previous = performance.now()
  const frame = (now: number) => {
    if (!active) return
    gaps.push(now - previous)
    previous = now
    requestAnimationFrame(frame)
  }
  const observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) longTasksMs.push(entry.duration)
  })
  if (PerformanceObserver.supportedEntryTypes.includes("longtask"))
    observer.observe({ type: "longtask", buffered: false })
  requestAnimationFrame(frame)
  try {
    const value = await work()
    return {
      value,
      worstFrameMs: gaps.length ? Math.max(...gaps) : null,
      longTasksMs,
    }
  } finally {
    active = false
    observer.disconnect()
  }
}

export async function runLarge(
  target: Target,
  targetName: string,
  progress: (message: string, fraction: number) => void,
  options: { full: boolean; smoke: boolean }
): Promise<LargeResult> {
  const response = await fetch("/fixtures/v1/large.json", { cache: "no-store" })
  if (!response.ok)
    throw new Error("Missing large fixtures. Run pnpm bench:fixtures --large.")
  const raw = await response.arrayBuffer()
  const manifest = JSON.parse(new TextDecoder().decode(raw)) as LargeManifest
  const fixtures = manifest.files.filter(fixture =>
    options.smoke
      ? largeLabel(fixture) === "records-8"
      : options.full || (fixture.basis !== "saved" && fixture.mib <= 32)
  )
  const api = { ImmutableString: target.ImmutableString, splice: target.splice }
  const samples: LargeSample[] = []

  const reopen = async (
    database: string,
    url: string,
    expected: { units: number; last: string | null }
  ) => {
    const session = target.open(database)
    try {
      const start = performance.now()
      const handle = await session.find(url)
      const loadMs = performance.now() - start
      const actual = largeSummary(handle.doc())
      if (actual.units !== expected.units || actual.last !== expected.last)
        throw new Error("Reopened content did not match")
      return loadMs
    } finally {
      await session.close()
    }
  }

  const scenario = async (
    name: LargeSample["scenario"],
    fixture: LargeFixture,
    run: (database: string) => Promise<Partial<LargeSample>>,
    keep = false
  ) => {
    const database = `automerge-repo-benchmark-${targetName}-large-${crypto.randomUUID()}`
    const sample: LargeSample = {
      scenario: name,
      fixture: largeLabel(fixture),
      shape: fixture.shape,
      mib: fixture.mib,
      callMs: null,
      durableMs: null,
      loadMs: null,
      worstFrameMs: null,
      longTasksMs: [],
      storeBytes: null,
      jsHeapBytes: null,
      error: null,
    }
    try {
      Object.assign(sample, await run(database))
      sample.storeBytes = (await storeSize(database)).bytes
      sample.jsHeapBytes = memory()
    } catch (error) {
      sample.error = String(error)
    }
    // A kept database is deleted by whoever reuses it.
    if (!keep || sample.error) await deleteDatabase(database).catch(() => {})
    samples.push(sample)
    return { sample, database }
  }

  for (const [index, fixture] of fixtures.entries()) {
    const label = largeLabel(fixture)
    progress(`Large ${label}: fetching`, index / fixtures.length)
    const fetched = await fetch(`/fixtures/v1/${fixture.name}`)
    const buffer = await fetched.arrayBuffer()
    if ((await sha256(buffer)) !== fixture.sha256)
      throw new Error(`Fixture mismatch: ${fixture.name}`)
    const bytes = new Uint8Array(buffer)

    progress(`Large ${label}: one change`, index / fixtures.length)
    await scenario("change", fixture, async database => {
      const session = target.open(database)
      let url: string, expected
      let callMs = 0
      const timed = await observed(async () => {
        try {
          const handle = await session.create(largeInitial(fixture))
          url = handle.url
          await session.flush()
          const [mutate] = largeParts({ ...fixture, parts: 1 }, api)
          const start = performance.now()
          const write = handle.change(mutate, { time: 0 })
          callMs = performance.now() - start
          await Promise.all([write, session.flush()])
          expected = largeSummary(handle.doc())
          return performance.now() - start
        } finally {
          await session.close()
        }
      })
      return {
        callMs,
        durableMs: timed.value,
        worstFrameMs: timed.worstFrameMs,
        longTasksMs: timed.longTasksMs,
        loadMs: await reopen(database, url!, expected!),
      }
    })

    progress(`Large ${label}: import`, index / fixtures.length)
    let importedUrl: string | undefined
    const imported = await scenario(
      "import",
      fixture,
      async database => {
        const session = target.open(database)
        let callMs = 0
        const timed = await observed(async () => {
          try {
            const start = performance.now()
            importedUrl = (await session.import(bytes.slice())).url
            callMs = performance.now() - start
            await session.flush()
            return performance.now() - start
          } finally {
            await session.close()
          }
        })
        return {
          callMs,
          durableMs: timed.value,
          worstFrameMs: timed.worstFrameMs,
          longTasksMs: timed.longTasksMs,
          loadMs: await reopen(database, importedUrl!, fixture),
        }
      },
      true
    )

    progress(`Large ${label}: merge`, index / fixtures.length)
    await scenario("merge", fixture, async database => {
      const session = target.open(database)
      const scratchName = `${database}-scratch`
      const scratch = target.open(scratchName)
      let url: string
      let callMs = 0
      try {
        const from = await scratch.import(bytes.slice())
        const into = await session.create({})
        url = into.url
        await session.flush()
        const timed = await observed(async () => {
          const start = performance.now()
          await into.merge(from as never)
          callMs = performance.now() - start
          await session.flush()
          return performance.now() - start
        })
        await scratch.close()
        await session.close()
        return {
          callMs,
          durableMs: timed.value,
          worstFrameMs: timed.worstFrameMs,
          longTasksMs: timed.longTasksMs,
          loadMs: await reopen(database, url, fixture),
        }
      } finally {
        await scratch.close().catch(() => {})
        await session.close().catch(() => {})
        await deleteDatabase(scratchName).catch(() => {})
      }
    })

    if (!imported.sample.error && importedUrl) {
      progress(`Large ${label}: small edits`, index / fixtures.length)
      const { database } = imported
      const url = importedUrl
      await scenario("edits", fixture, async () => {
        const session = target.open(database)
        const callMs: number[] = []
        const pending: Promise<void>[] = []
        try {
          const handle = await session.find<any>(url)
          const timed = await observed(async () => {
            const start = performance.now()
            for (let i = 0; i < 100; i++) {
              const begin = performance.now()
              const write = handle.change(
                (doc: any) => {
                  if (fixture.shape === "text")
                    target.splice(doc, ["text"], i, 0, "x")
                  else doc.rows[(i * 7919) % doc.rows.length].score = i
                },
                { time: 0 }
              )
              callMs.push(performance.now() - begin)
              if (write) pending.push(write)
              if (i % 10 === 9)
                await new Promise(resolve => requestAnimationFrame(resolve))
            }
            await Promise.all([session.flush(), ...pending])
            return performance.now() - start
          })
          const sorted = [...callMs].sort((a, b) => a - b)
          return {
            callMs: sorted[49],
            callP95Ms: sorted[94],
            durableMs: timed.value,
            worstFrameMs: timed.worstFrameMs,
            longTasksMs: timed.longTasksMs,
          }
        } finally {
          await session.close()
          await deleteDatabase(database).catch(() => {})
        }
      })
    }
  }
  return {
    schema: 1,
    mode: "large",
    target: { id: targetName, adapter: target.adapter },
    fixtureSha256: await sha256(raw),
    userAgent: navigator.userAgent,
    timestamp: new Date().toISOString(),
    samples,
  }
}
