// Runs in a separate Node process per target, to isolate each version's runtime.
import "@automerge/automerge"
import { readFile, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { fileURLToPath, pathToFileURL } from "node:url"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import { Session as InspectorSession } from "node:inspector"
import { MemoryStore } from "./memory.mjs"

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

async function fromFile(path) {
  return import(pathToFileURL(path).href)
}

let open
if (target === "poc") {
  const { Repo } = await import("@automerge/automerge-repo")
  await import("@automerge/subduction")
  const { createSubductionPeer } =
    await import("@automerge/automerge-repo-subduction")
  open = store => {
    const peer = createSubductionPeer({ storage: store.bytes() })
    const repo = new Repo({ backend: peer.backend })
    return {
      import: bytes => repo.import(bytes),
      create: initial => repo.create(initial),
      find: url => repo.find(url),
      flush: () => repo.flush(),
      close: async () => {
        try {
          await repo.shutdown()
        } finally {
          await peer.close()
        }
      },
    }
  }
} else {
  const base = join(directory, "packages/automerge-repo")
  const { Repo } = await fromFile(join(base, "dist/entrypoints/fullfat.js"))
  if (target === "subductionjs") {
    const native = join(
      base,
      "node_modules/@automerge/automerge-subduction/dist/esm"
    )
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
profiler?.disconnect()
await writeFile(
  output,
  JSON.stringify(
    {
      schema: 3,
      target,
      node: process.version,
      fixtureSha256,
      seed: before,
      samples,
      writes,
      imports,
      importFixtureSha256,
    },
    null,
    2
  ) + "\n"
)
