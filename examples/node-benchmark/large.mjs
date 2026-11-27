// Large-document scenarios for one target, in its own Node process. Fixtures
// come from `generate.mjs --large`. See README "Large documents".
import { readFile, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import { Session as InspectorSession } from "node:inspector"
import { MemoryStore } from "./memory.mjs"
import { loadTarget } from "./targets.mjs"
import {
  largeInitial,
  largeLabel,
  largeParts,
  largeSummary,
} from "../browser-benchmark/src/large.ts"

// One fixture per process: a WASM panic poisons the module for the rest of
// the process, so a crash must not turn later samples into failures.
// Likewise one scenario group per process: `change`, `import` (+ `edits` on
// its store), or `merge`.
const {
  target,
  directory,
  runs,
  output,
  profile,
  fixture: name,
  group,
} = JSON.parse(process.argv[2])
const fixtureDirectory = fileURLToPath(
  new URL("../browser-benchmark/public/fixtures/v1/", import.meta.url)
)
const rawManifest = await readFile(join(fixtureDirectory, "large.json")).catch(
  () => {
    throw new Error("Missing large fixtures: run pnpm bench:fixtures --large")
  }
)
const fixtureSha256 = createHash("sha256").update(rawManifest).digest("hex")
const fixtures = JSON.parse(rawManifest).files.filter(f => f.name === name)
if (fixtures.length !== 1) throw new Error(`Unknown large fixture ${name}`)

const { open, automerge } = await loadTarget(target, directory)
const api = {
  ImmutableString: automerge.ImmutableString,
  splice: automerge.splice,
}

const profiler = profile ? new InspectorSession() : null
if (profiler) profiler.connect()
const post = (method, params) =>
  new Promise((resolve, reject) =>
    profiler.post(method, params, (error, result) =>
      error ? reject(error) : resolve(result)
    )
  )
async function profiled(name, enabled, fn) {
  if (!enabled) return fn()
  await post("Profiler.enable")
  await post("Profiler.start")
  try {
    return await fn()
  } finally {
    const { profile: cpuProfile } = await post("Profiler.stop")
    await writeFile(
      join(profile, `${target}-${name}.cpuprofile`),
      JSON.stringify(cpuProfile)
    )
  }
}

const memory = () => {
  const { rss, heapUsed, external, arrayBuffers } = process.memoryUsage()
  return { rss, heapUsed, external, arrayBuffers }
}
const percentile = (values, p) =>
  [...values].sort((a, b) => a - b)[Math.ceil(p * values.length) - 1]

/** Reopen the store in a fresh Repo, time `find()`, and check the content.
 * A failure here is reported apart from the write: in one process, the
 * reload can exhaust WASM memory the written document still holds. */
async function reopen(store, url, expected) {
  try {
    return { loadMs: await reload(store, url, expected) }
  } catch (error) {
    return { loadMs: null, reloadError: String(error) }
  }
}

async function reload(store, url, expected) {
  const session = open(store)
  try {
    const start = performance.now()
    const handle = await session.find(url)
    const loadMs = performance.now() - start
    const actual = largeSummary(handle.doc())
    if (actual.units !== expected.units || actual.last !== expected.last)
      throw new Error(
        `Reopened content mismatch: ${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`
      )
    return loadMs
  } finally {
    await session.close()
  }
}

// One change holding the whole fixture's content: a paste, or `A.from(json)`.
async function change(fixture, profiling) {
  const store = new MemoryStore()
  const session = open(store)
  let url, expected, callMs, durableMs
  try {
    const handle = await session.create(largeInitial(fixture))
    url = handle.url
    await session.flush()
    const [mutate] = largeParts({ ...fixture, parts: 1 }, api)
    await profiled(`change-${largeLabel(fixture)}`, profiling, async () => {
      const start = performance.now()
      const write = handle.change(mutate, { time: 0 })
      callMs = performance.now() - start
      await Promise.all([write, session.flush()])
      durableMs = performance.now() - start
    })
    expected = largeSummary(handle.doc())
  } finally {
    await session.close()
  }
  return {
    callMs,
    durableMs,
    ...(await reopen(store, url, expected)),
    store,
  }
}

async function importFixture(fixture, bytes, profiling) {
  const store = new MemoryStore()
  const session = open(store)
  let url, callMs, durableMs
  try {
    await profiled(`import-${largeLabel(fixture)}`, profiling, async () => {
      const start = performance.now()
      url = (await session.import(bytes.slice())).url
      callMs = performance.now() - start
      await session.flush()
      durableMs = performance.now() - start
    })
  } finally {
    await session.close()
  }
  return {
    callMs,
    durableMs,
    ...(await reopen(store, url, fixture)),
    store,
    url,
  }
}

// Merge an imported history into an existing, unrelated document.
async function merge(fixture, bytes, profiling) {
  const store = new MemoryStore()
  const session = open(store)
  const scratch = open(new MemoryStore())
  let url, callMs, durableMs
  try {
    const from = await scratch.import(bytes.slice())
    const into = await session.create({})
    url = into.url
    await session.flush()
    await profiled(`merge-${largeLabel(fixture)}`, profiling, async () => {
      const start = performance.now()
      await into.merge(from)
      callMs = performance.now() - start
      await session.flush()
      durableMs = performance.now() - start
    })
  } finally {
    await scratch.close()
    await session.close()
  }
  return { callMs, durableMs, ...(await reopen(store, url, fixture)), store }
}

// Small edits to a stored large document, after a fresh load.
async function edits(fixture, store, url, profiling) {
  const count = 100
  const session = open(store)
  const callMs = []
  const pending = []
  let totalMs
  try {
    const handle = await session.find(url)
    await profiled(`edits-${largeLabel(fixture)}`, profiling, async () => {
      const start = performance.now()
      for (let i = 0; i < count; i++) {
        const begin = performance.now()
        const write = handle.change(
          doc => {
            if (fixture.shape === "text") api.splice(doc, ["text"], i, 0, "x")
            else doc.rows[(i * 7919) % doc.rows.length].score = i
          },
          { time: 0 }
        )
        callMs.push(performance.now() - begin)
        if (write) pending.push(write)
      }
      await Promise.all([session.flush(), ...pending])
      totalMs = performance.now() - start
    })
  } finally {
    await session.close()
  }
  return {
    count,
    callP50Ms: percentile(callMs, 0.5),
    callP95Ms: percentile(callMs, 0.95),
    callMaxMs: Math.max(...callMs),
    totalMs,
  }
}

const samples = []
for (let round = 0; round < runs; round++) {
  for (const fixture of fixtures) {
    const bytes = await readFile(join(fixtureDirectory, fixture.name))
    if (createHash("sha256").update(bytes).digest("hex") !== fixture.sha256)
      throw new Error(`Fixture mismatch: ${fixture.name}`)
    const profiling = !!profiler && round === 0
    const record = async (scenario, run) => {
      const sample = {
        round: round + 1,
        scenario,
        fixture: largeLabel(fixture),
        shape: fixture.shape,
        mib: fixture.mib,
        basis: fixture.basis ?? "changes",
        error: null,
      }
      try {
        const { store, url, ...result } = await run()
        Object.assign(sample, result, { size: store?.size(), memory: memory() })
        console.log(
          `${target} round ${round + 1}/${runs}, ${scenario} ${largeLabel(fixture)}: ${result.durableMs?.toFixed(0) ?? result.totalMs?.toFixed(0)} ms${result.loadMs ? `, reload ${result.loadMs.toFixed(0)} ms` : result.reloadError ? `, reload failed: ${result.reloadError.slice(0, 80)}` : ""}`
        )
        samples.push(sample)
        return { store, url }
      } catch (error) {
        sample.error = String(error?.stack ?? error)
        console.log(`${target} ${scenario} ${fixture.name} failed: ${error}`)
        samples.push(sample)
        return {}
      }
    }
    if (group === "change")
      await record("change", () => change(fixture, profiling))
    if (group === "import") {
      const imported = await record("import", () =>
        importFixture(fixture, bytes, profiling)
      )
      if (imported.store)
        await record("edits", () =>
          edits(fixture, imported.store, imported.url, profiling)
        )
    }
    if (group === "merge")
      await record("merge", () => merge(fixture, bytes, profiling))
  }
}
profiler?.disconnect()
await writeFile(
  output,
  JSON.stringify(
    {
      schema: 1,
      target,
      node: process.version,
      fixtureSha256,
      maxRss: process.resourceUsage().maxRSS * 1024,
      samples,
    },
    null,
    2
  ) + "\n"
)
