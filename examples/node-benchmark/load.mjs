// Runs in a separate Node process per target, to isolate each version's runtime.
// Fullfat initializes Automerge's WASM for this process.
// eslint-disable-next-line no-restricted-imports
import { splice as currentSplice } from "@automerge/automerge"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { createHash } from "node:crypto"
import { fileURLToPath, pathToFileURL } from "node:url"
import { join, relative } from "node:path"
import { performance } from "node:perf_hooks"
import { Session as InspectorSession } from "node:inspector"
import { deserialize, serialize } from "node:v8"
import { MemoryStore } from "./memory.mjs"
import {
  bucketSummary,
  canonicalJson,
  mixedCounts,
  replayBatch,
} from "../browser-benchmark/src/mixed.ts"

const { target, directory, runs, smoke, output, profile } = JSON.parse(
  process.argv[2]
)
const fixtureDirectory = fileURLToPath(
  new URL("../browser-benchmark/public/fixtures/v1/", import.meta.url)
)
const rawManifest = await readFile(join(fixtureDirectory, "manifest.json"))
const fixtureSha256 = createHash("sha256").update(rawManifest).digest("hex")
const manifest = JSON.parse(rawManifest)
const counts = smoke ? [10] : [10, 100, 500, 1000]
if (manifest.version !== 1 || manifest.files.length < counts.at(-1))
  throw new Error("Missing fixtures: run pnpm bench:fixtures")

const fixtures = await Promise.all(
  manifest.files.slice(0, counts.at(-1)).map(async item => {
    const bytes = await readFile(join(fixtureDirectory, item.name))
    if (
      bytes.length !== item.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== item.sha256
    )
      throw new Error(`Fixture mismatch: ${item.name}`)
    return bytes
  })
)
const rawImportManifest = await readFile(join(fixtureDirectory, "imports.json"))
const importFixtureSha256 = createHash("sha256")
  .update(rawImportManifest)
  .digest("hex")
const importManifest = JSON.parse(rawImportManifest)
if (importManifest.version !== 1 || !importManifest.files.length)
  throw new Error("Missing import fixtures: run pnpm bench:fixtures")
const importClasses = [
  {
    name: "small",
    records: manifest.changes + 1,
    files: fixtures.slice(0, smoke ? 3 : 20).map(bytes => ({
      bytes,
      count: 50,
    })),
  },
  ...importManifest.files
    .filter(item => !smoke || "count" in item)
    .map(item => ({
      name: item.name.replace(/^import-|\.automerge$/g, ""),
      records: item.records,
      files: Array.from({ length: smoke ? 1 : 3 }, () => item),
    })),
]
for (const entry of importClasses) {
  entry.files = await Promise.all(
    entry.files.map(async item => {
      if (item.bytes instanceof Uint8Array) return item
      const bytes = await readFile(join(fixtureDirectory, item.name))
      if (
        bytes.length !== item.bytes ||
        createHash("sha256").update(bytes).digest("hex") !== item.sha256
      )
        throw new Error(`Fixture mismatch: ${item.name}`)
      return { ...item, bytes }
    })
  )
}

const rawMixed = await readFile(join(fixtureDirectory, "mixed.json")).catch(
  () => {
    throw new Error("Missing mixed fixtures: run pnpm bench:fixtures")
  }
)
const mixedFixtureSha256 = createHash("sha256").update(rawMixed).digest("hex")
const mixedManifest = JSON.parse(rawMixed)
const mixedLoadCounts = mixedCounts(smoke)
if (
  mixedManifest.version !== 1 ||
  mixedManifest.docs.length < mixedLoadCounts.at(-1)
)
  throw new Error("Missing mixed fixtures: run pnpm bench:fixtures")
const mixedDocs = mixedManifest.docs.slice(0, mixedLoadCounts.at(-1))

async function fromFile(path) {
  return import(pathToFileURL(path).href)
}

let open
// The branch's own Automerge `splice`, for text edits inside `change`.
let splice = currentSplice
// Built code the seeded mixed store depends on, for its cache key.
let codePaths
if (target === "poc") {
  const root = fileURLToPath(new URL("../../", import.meta.url))
  codePaths = [
    join(root, "packages/automerge-repo/dist"),
    join(root, "packages/automerge-repo-subduction/dist"),
    realpathSync(
      join(root, "packages/automerge-repo/node_modules/@automerge/automerge")
    ),
    realpathSync(
      join(
        root,
        "packages/automerge-repo-subduction/node_modules/@automerge/subduction"
      )
    ),
  ]
  const { Repo } = await import("@automerge/automerge-repo")
  await import("@automerge/subduction")
  const { SubductionBackend } =
    await import("@automerge/automerge-repo-subduction")
  open = store => {
    const backend = new SubductionBackend({ storage: store.bytes() })
    const repo = new Repo({ backend })
    return {
      import: bytes => repo.import(bytes),
      create: initial => repo.create(initial),
      clone: handle => repo.clone(handle),
      find: url => repo.find(url),
      flush: () => repo.flush(),
      close: async () => {
        try {
          await repo.shutdown()
        } finally {
          await backend.close()
        }
      },
    }
  }
} else {
  const base = join(directory, "packages/automerge-repo")
  const { Repo } = await fromFile(join(base, "dist/entrypoints/fullfat.js"))
  const automerge = realpathSync(
    join(base, "node_modules/@automerge/automerge")
  )
  ;({ splice } = await fromFile(
    join(automerge, "dist/mjs/entrypoints/slim.js")
  ))
  codePaths = [join(base, "dist"), automerge]
  if (target === "subductionjs") {
    const native = join(
      base,
      "node_modules/@automerge/automerge-subduction/dist/esm"
    )
    codePaths.push(realpathSync(native))
    const { initSync } = await fromFile(join(native, "slim.js"))
    const { wasmBase64 } = await fromFile(join(native, "wasm-base64.js"))
    initSync({ module: Uint8Array.from(Buffer.from(wasmBase64, "base64")) })
  }
  open = store => {
    const repo = new Repo({
      storage: store.legacy(),
      ...(target === "subductionjs"
        ? { subductionWebsocketEndpoints: [] }
        : {}),
    })
    return {
      import: bytes => repo.import(bytes),
      create: initial => repo.create(initial),
      clone: async handle => repo.clone(handle),
      find: url => repo.find(url),
      flush: () => repo.flush(),
      close: () => repo.shutdown(),
    }
  }
}

const store = new MemoryStore()
const seeded = open(store)
const urls = []
try {
  // Same seed batch width as browser harness; setup is not timed.
  for (let start = 0; start < fixtures.length; start += 20) {
    const batch = await Promise.all(
      fixtures.slice(start, start + 20).map(bytes => seeded.import(bytes))
    )
    urls.push(...batch.map(handle => handle.url))
  }
  await seeded.flush()
} finally {
  await seeded.close()
}
const before = store.size()
if (!before.keys) throw new Error("Seed did not persist any records")
const percentile = (values, p) =>
  [...values].sort((a, b) => a - b)[Math.ceil(p * values.length) - 1]
const samples = []
const profiler = profile ? new InspectorSession() : null
if (profiler) profiler.connect()
const post = (method, params) =>
  new Promise((resolve, reject) =>
    profiler.post(method, params, (error, result) =>
      error ? reject(error) : resolve(result)
    )
  )
for (let round = 0; round < runs; round++) {
  for (const count of counts) {
    store.resetStats()
    const session = open(store)
    let readyMs, totalMs, stats
    const profiling = !!profiler && round === 0 && count === counts.at(-1)
    try {
      if (profiling) {
        await post("Profiler.enable")
        await post("Profiler.start")
      }
      const start = performance.now()
      // No await between find calls: one loading wave, as in the browser run.
      readyMs = await Promise.all(
        urls.slice(0, count).map((url, i) =>
          session.find(url).then(handle => {
            if (handle.doc()?.count !== 50)
              throw new Error(`Incorrect document ${i}`)
            return performance.now() - start
          })
        )
      )
      totalMs = performance.now() - start
      stats = store.stats()
    } finally {
      if (profiling) {
        const { profile: cpuProfile } = await post("Profiler.stop")
        await writeFile(profile, JSON.stringify(cpuProfile))
      }
      await session.close()
    }
    const after = store.size()
    if (before.keys !== after.keys || before.bytes !== after.bytes)
      throw new Error("Load changed the store")
    samples.push({
      round: round + 1,
      count,
      totalMs,
      p50Ms: percentile(readyMs, 0.5),
      p95Ms: percentile(readyMs, 0.95),
      p99Ms: percentile(readyMs, 0.99),
      maxMs: Math.max(...readyMs),
      storage: stats,
    })
    console.log(
      `${target} round ${round + 1}/${runs}, ${count} docs: ${totalMs.toFixed(1)} ms`
    )
  }
}
// Mixed documents are replayed through this target's Repo, so the store holds
// whatever this branch writes for incrementally edited, multi-author documents.
// Replay is slow and deterministic, so the verified store is cached on disk,
// keyed by the fixtures, harness and built code it came from.
async function hashPaths(paths) {
  const hash = createHash("sha256")
  for (const path of paths) {
    const files = (
      await readdir(path, { recursive: true, withFileTypes: true })
    )
      .filter(entry => entry.isFile())
      .map(entry => join(entry.parentPath, entry.name))
      .sort()
    for (const file of files) {
      hash.update(relative(path, file)).update(await readFile(file))
    }
    hash.update(path)
  }
  return hash.digest("hex")
}

async function seedMixed() {
  const here = fileURLToPath(new URL(".", import.meta.url))
  const harness = [
    fileURLToPath(new URL("./load.mjs", import.meta.url)),
    fileURLToPath(new URL("./memory.mjs", import.meta.url)),
    fileURLToPath(
      new URL("../browser-benchmark/src/mixed.ts", import.meta.url)
    ),
  ]
  const key = createHash("sha256")
    .update(
      JSON.stringify({
        target,
        smoke,
        mixedFixtureSha256,
        harness: await Promise.all(harness.map(file => readFile(file, "utf8"))),
        code: await hashPaths(codePaths),
      })
    )
    .digest("hex")
  const cacheDirectory = join(here, "results", "seed-cache")
  const file = join(
    cacheDirectory,
    `${target}-mixed${smoke ? "-smoke" : ""}-${key.slice(0, 16)}.v8`
  )
  try {
    const { entries, urls } = deserialize(await readFile(file))
    return {
      store: MemoryStore.restore(entries),
      urls,
      cached: true,
      seedMs: 0,
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  const started = performance.now()
  const mixedStore = new MemoryStore()
  const session = open(mixedStore)
  const urls = []
  try {
    for (let start = 0; start < mixedDocs.length; start += 20) {
      // Concurrent authors live in a scratch Repo; only merges reach the store.
      const scratch = open(new MemoryStore())
      const pending = []
      const track = write => {
        if (write) pending.push(write)
      }
      try {
        const results = await replayBatch(
          mixedDocs.slice(start, start + 20),
          {
            create: initial => session.create(initial),
            change: (handle, edit) => track(handle.change(edit, { time: 0 })),
            fork: handle => scratch.clone(handle),
            merge: (into, from) => track(into.merge(from)),
            splice,
          },
          async () => {
            await Promise.all([session.flush(), ...pending.splice(0)])
          }
        )
        urls.push(...results.map(({ handle }) => handle.url))
      } finally {
        await scratch.close()
      }
      console.log(
        `${target} mixed seed: ${urls.length}/${mixedDocs.length} documents`
      )
    }
    await session.flush()
  } finally {
    await session.close()
  }
  const reader = open(mixedStore)
  try {
    for (let i = 0; i < urls.length; i++) {
      const json = canonicalJson((await reader.find(urls[i])).doc())
      if (
        createHash("sha256").update(json).digest("hex") !== mixedDocs[i].sha256
      )
        throw new Error(`Mixed document ${i} content mismatch`)
    }
  } finally {
    await reader.close()
  }
  const seedMs = performance.now() - started
  await mkdir(cacheDirectory, { recursive: true })
  await writeFile(file, serialize({ entries: mixedStore.snapshot(), urls }))
  return { store: mixedStore, urls, cached: false, seedMs }
}

const mixedSeed = await seedMixed()
const mixedBefore = mixedSeed.store.size()
console.log(
  `${target} mixed store: ${mixedBefore.keys} keys, ${mixedBefore.bytes} bytes${mixedSeed.cached ? " (cached)" : `, seeded in ${(mixedSeed.seedMs / 1000).toFixed(1)} s`}`
)
const mixedSamples = []
for (let round = 0; round < runs; round++) {
  for (const count of mixedLoadCounts) {
    mixedSeed.store.resetStats()
    const session = open(mixedSeed.store)
    let readyMs, totalMs, stats
    try {
      const start = performance.now()
      // The seal is the final change, so seeing it means the whole history loaded.
      readyMs = await Promise.all(
        mixedSeed.urls.slice(0, count).map((url, i) =>
          session.find(url).then(handle => {
            if (handle.doc()?.seal !== mixedDocs[i].seal)
              throw new Error(`Incorrect mixed document ${i}`)
            return performance.now() - start
          })
        )
      )
      totalMs = performance.now() - start
      stats = mixedSeed.store.stats()
    } finally {
      await session.close()
    }
    const after = mixedSeed.store.size()
    if (mixedBefore.keys !== after.keys || mixedBefore.bytes !== after.bytes)
      throw new Error("Mixed load changed the store")
    mixedSamples.push({
      round: round + 1,
      count,
      totalMs,
      p50Ms: percentile(readyMs, 0.5),
      p95Ms: percentile(readyMs, 0.95),
      p99Ms: percentile(readyMs, 0.99),
      maxMs: Math.max(...readyMs),
      buckets: bucketSummary(readyMs, mixedDocs),
      storage: stats,
    })
    console.log(
      `${target} round ${round + 1}/${runs}, ${count} mixed docs: ${totalMs.toFixed(1)} ms`
    )
  }
}

const imports = []
for (let round = 0; round < runs; round++) {
  for (const entry of importClasses) {
    for (const fixture of entry.files) {
      const importStore = new MemoryStore()
      const session = open(importStore)
      const sample = {
        round: round + 1,
        fixture: entry.name,
        records: entry.records,
        bytes: fixture.bytes.length,
        importMs: null,
        flushMs: null,
        verified: false,
        error: null,
        storage: null,
        size: null,
      }
      let url
      try {
        try {
          const started = performance.now()
          url = (await session.import(fixture.bytes.slice())).url
          sample.importMs = performance.now() - started
          const flushStarted = performance.now()
          await session.flush()
          sample.flushMs = performance.now() - flushStarted
          sample.storage = importStore.stats()
        } finally {
          await session.close()
        }
        sample.size = importStore.size()
        const reopened = open(importStore)
        try {
          const doc = (await reopened.find(url)).doc()
          if ("count" in fixture) {
            if (doc?.count !== fixture.count)
              throw new Error("Reopened count did not match")
          } else {
            const text = doc?.text
            if (
              typeof text !== "string" ||
              text.length !== fixture.textLength ||
              createHash("sha256").update(text).digest("hex") !==
                fixture.textSha256
            )
              throw new Error("Reopened text did not match")
          }
          sample.verified = true
        } finally {
          await reopened.close()
        }
      } catch (error) {
        sample.error = String(error)
      }
      imports.push(sample)
      console.log(
        `${target} round ${round + 1}/${runs}, import ${entry.name}: ${sample.importMs?.toFixed(1) ?? "failed"} ms${sample.error ? ` (${sample.error})` : ""}`
      )
    }
  }
}
const writes = { creates: [], burst: [] }
for (let round = 0; round < runs; round++) {
  for (const kind of ["creates", "burst"]) {
    const count = kind === "creates" ? (smoke ? 10 : 100) : smoke ? 30 : 500
    const writeStore = new MemoryStore()
    const session = open(writeStore)
    const urls = []
    const callMs = []
    const pending = []
    let handle
    try {
      if (kind === "burst") {
        handle = await session.create({
          count: 0,
          items: Array(32).fill("initial"),
        })
        urls.push(handle.url)
        await session.flush()
      }
      writeStore.resetStats()
      const started = performance.now()
      if (kind === "creates") {
        for (let i = 0; i < count; i += 20) {
          const batch = await Promise.all(
            Array.from({ length: Math.min(20, count - i) }, async (_, j) => {
              const start = performance.now()
              const created = await session.create({
                count: i + j,
                items: Array(32).fill("initial"),
              })
              return { url: created.url, ms: performance.now() - start }
            })
          )
          for (const item of batch) {
            urls.push(item.url)
            callMs.push(item.ms)
          }
        }
      } else {
        for (let i = 1; i <= count; i++) {
          const start = performance.now()
          const write = handle.change(
            doc => {
              doc.count = i
              doc.items[i % 32] = `revision-${i}`
            },
            { time: 0 }
          )
          callMs.push(performance.now() - start)
          if (write) pending.push(write)
        }
      }
      const submitMs = performance.now() - started
      const drainStart = performance.now()
      await Promise.all([session.flush(), Promise.all(pending)])
      const drainMs = performance.now() - drainStart
      const totalMs = performance.now() - started
      const storage = writeStore.stats()
      await session.close()
      const size = writeStore.size()
      const reopened = open(writeStore)
      try {
        for (let i = 0; i < urls.length; i++) {
          const restored = await reopened.find(urls[i])
          const doc = restored.doc()
          const expected = kind === "creates" ? i : count
          if (
            doc?.count !== expected ||
            doc.items[expected % 32] !==
              (kind === "creates" ? "initial" : `revision-${count}`)
          )
            throw new Error(`${kind} reopen verification failed at ${i}`)
        }
      } finally {
        await reopened.close()
      }
      writes[kind].push({
        round: round + 1,
        count,
        submitMs,
        drainMs,
        totalMs,
        opsPerSecond: (count * 1000) / totalMs,
        callMs,
        storage,
        size,
        verified: true,
      })
      console.log(
        `${target} round ${round + 1}/${runs}, ${kind}: ${totalMs.toFixed(1)} ms`
      )
    } catch (error) {
      // Failed samples must not look like fast, successful writes.
      throw new Error(
        `${target} round ${round + 1} ${kind}: ${String(error)}`,
        { cause: error }
      )
    }
  }
}
// Incremental edits leave loose commits behind each fragment; imports don't.
// Write one document, then time loading it from a fresh Repo on the same store.
const history = []
const historyEdits = smoke ? 1000 : 3000
for (let round = 0; round < runs; round++) {
  const historyStore = new MemoryStore()
  const writer = open(historyStore)
  let url
  const pending = []
  const writeStart = performance.now()
  try {
    const handle = await writer.create({
      count: 0,
      items: Array(32).fill("initial"),
    })
    url = handle.url
    for (let i = 1; i <= historyEdits; i++) {
      const write = handle.change(
        doc => {
          doc.count = i
          doc.items[i % 32] = `revision-${i}`
        },
        { time: 0 }
      )
      if (write) pending.push(write)
      // Yield so a synchronous edit loop can't retain every pending write.
      if (i % 100 === 0) await new Promise(resolve => setImmediate(resolve))
    }
    await Promise.all([writer.flush(), Promise.all(pending)])
  } finally {
    await writer.close()
  }
  const writeMs = performance.now() - writeStart
  const keys = historyStore.keys()
  const count = part =>
    keys.filter(key => typeof key === "string" && key.includes(`/${part}/`))
      .length
  const stored = {
    ...historyStore.size(),
    // Only PoC keys distinguish loose commits from fragments.
    commits: target === "poc" ? count("commits") : null,
    fragments: target === "poc" ? count("fragments") : null,
  }
  historyStore.resetStats()
  const reader = open(historyStore)
  let loadMs, storage
  try {
    const start = performance.now()
    const doc = (await reader.find(url)).doc()
    loadMs = performance.now() - start
    storage = historyStore.stats()
    if (
      doc?.count !== historyEdits ||
      doc.items[historyEdits % 32] !== `revision-${historyEdits}`
    )
      throw new Error("history reopen verification failed")
  } finally {
    await reader.close()
  }
  history.push({
    round: round + 1,
    edits: historyEdits,
    writeMs,
    loadMs,
    stored,
    storage,
    verified: true,
  })
  console.log(
    `${target} round ${round + 1}/${runs}, history ${historyEdits} edits: write ${writeMs.toFixed(1)} ms, load ${loadMs.toFixed(1)} ms, ${stored.keys} keys`
  )
}
profiler?.disconnect()
await writeFile(
  output,
  JSON.stringify(
    {
      schema: 5,
      target,
      node: process.version,
      fixtureSha256,
      seed: before,
      samples,
      mixed: {
        fixtureSha256: mixedFixtureSha256,
        seed: {
          ...mixedBefore,
          cached: mixedSeed.cached,
          seedMs: mixedSeed.seedMs,
        },
        samples: mixedSamples,
      },
      writes,
      history,
      imports,
      importFixtureSha256,
    },
    null,
    2
  ) + "\n"
)
