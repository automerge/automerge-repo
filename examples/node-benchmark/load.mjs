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
profiler?.disconnect()
await writeFile(
  output,
  JSON.stringify(
    {
      schema: 1,
      target,
      node: process.version,
      fixtureSha256,
      seed: before,
      samples,
    },
    null,
    2
  ) + "\n"
)
