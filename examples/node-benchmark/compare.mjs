import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { largeLabel } from "../browser-benchmark/src/large.ts"
import {
  prepare,
  readIndex,
  command,
  root,
} from "../browser-benchmark/prepare.mjs"

const directory = fileURLToPath(new URL(".", import.meta.url))
const smoke = process.argv.includes("--smoke")
const profile = process.argv.includes("--profile")
const large = process.argv.includes("--large")
// Large fixture labels to run, e.g. --only=records-8,records-saved-32.
const only =
  process.argv
    .find(arg => arg.startsWith("--only="))
    ?.slice(7)
    .split(",") ?? null
const runs = Number(
  process.argv.find(arg => arg.startsWith("--runs="))?.slice(7) ?? 3
)
if (!Number.isSafeInteger(runs) || runs < 1)
  throw new Error("--runs must be positive")
const names = process.argv.slice(2).filter(arg => !arg.startsWith("--"))
if (!names.length) names.push("main", "subductionjs", "poc")
if (names.some(name => !/^[a-z][a-z0-9-]*$/.test(name)))
  throw new Error("Invalid target name")
if (names.some(name => !["main", "subductionjs", "poc"].includes(name)))
  throw new Error("Supported targets: main, subductionjs, poc")
const temp = await mkdtemp(join(tmpdir(), "automerge-node-bench-"))

// One process per large fixture and scenario group; a crashed process
// becomes a failed sample.
async function runLarge(name, info, profilePath, revision) {
  const manifest = JSON.parse(
    await readFile(
      join(directory, "../browser-benchmark/public/fixtures/v1/large.json"),
      "utf8"
    )
  )
  const fixtures = manifest.files.filter(fixture =>
    smoke
      ? largeLabel(fixture) === "records-8"
      : !only || only.includes(largeLabel(fixture))
  )
  const merged = { target: name, revision, samples: [], maxRss: {} }
  for (const fixture of fixtures) {
    for (const group of ["change", "import", "merge"]) {
      const label = `${largeLabel(fixture)} ${group}`
      const output = join(temp, `${name}-${largeLabel(fixture)}-${group}.json`)
      try {
        execFileSync(
          process.execPath,
          [
            // The largest fixtures hold millions of rows in JS.
            "--max-old-space-size=16384",
            join(directory, "large.mjs"),
            JSON.stringify({
              target: name,
              directory: info?.path,
              runs,
              output,
              profile: profilePath,
              fixture: fixture.name,
              group,
            }),
          ],
          { cwd: directory, stdio: "inherit", env: process.env }
        )
        const result = JSON.parse(await readFile(output, "utf8"))
        merged.node = result.node
        merged.fixtureSha256 = result.fixtureSha256
        merged.samples.push(...result.samples)
        merged.maxRss[label] = result.maxRss
      } catch (error) {
        console.log(`${name} ${label} process failed: ${error}`)
        merged.samples.push({
          scenario: group,
          fixture: largeLabel(fixture),
          error: String(error),
        })
      }
    }
  }
  return merged
}
const results = {}
const resultDirectory = join(directory, "results")
await mkdir(resultDirectory, { recursive: true })
try {
  for (const name of names) {
    const defaults = {
      main: ["base/main", "legacy"],
      subductionjs: ["base/subductionjs", "subductionjs"],
    }
    const index = await readIndex()
    const info =
      name === "poc"
        ? null
        : (index[name] ??
          (defaults[name] && (await prepare(name, ...defaults[name]))))
    if (name !== "poc" && !info)
      throw new Error(`Unknown target ${name}; run bench:prepare`)
    if (
      name !== "poc" &&
      info.adapter !== (name === "main" ? "legacy" : "subductionjs")
    )
      throw new Error(`Unexpected adapter for ${name}: ${info.adapter}`)
    if (name === "poc") {
      command(
        "pnpm",
        ["--filter", "@automerge/automerge-repo-subduction...", "build"],
        root
      )
    }
    const output = join(temp, `${name}.json`)
    const stamp = new Date().toISOString().replaceAll(":", "-")
    let profilePath = null
    if (profile && large) {
      // One profile per large scenario, in a directory per run.
      profilePath = join(resultDirectory, `large-${stamp}`)
      await mkdir(profilePath, { recursive: true })
    } else if (profile)
      profilePath = join(resultDirectory, `${name}-${stamp}.cpuprofile`)
    const revision = info?.sha ?? command("git", ["rev-parse", "HEAD"])
    if (large) {
      results[name] = await runLarge(name, info, profilePath, revision)
      continue
    }
    const args = [
      join(directory, "load.mjs"),
      JSON.stringify({
        target: name,
        directory: info?.path,
        runs,
        smoke,
        output,
        profile: profilePath,
      }),
    ]
    execFileSync(process.execPath, args, {
      cwd: directory,
      stdio: "inherit",
      env: process.env,
    })
    results[name] = {
      ...JSON.parse(await readFile(output, "utf8")),
      revision,
    }
  }
} finally {
  await rm(temp, { recursive: true, force: true })
}
const hashes = new Set(
  Object.values(results)
    .map(r => r.fixtureSha256)
    .filter(Boolean)
)
if (hashes.size !== 1) throw new Error("Fixture hashes differ")
const median = values =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
if (large) {
  const keys = new Set(
    Object.values(results).flatMap(result =>
      result.samples.map(s => `${s.scenario} ${s.fixture}`)
    )
  )
  const pick = (samples, key) => {
    const values = samples.map(s => s[key]).filter(v => v != null)
    return values.length ? +median(values).toFixed(1) : null
  }
  const largeSummary = Object.fromEntries(
    [...keys].map(key => [
      key,
      Object.fromEntries(
        names.map(name => {
          const samples = results[name].samples.filter(
            s => `${s.scenario} ${s.fixture}` === key
          )
          const ok = samples.filter(s => !s.error)
          return [
            name,
            {
              failures: samples.length - ok.length,
              callMs: pick(ok, "callMs") ?? pick(ok, "callP95Ms"),
              durableMs: pick(ok, "durableMs") ?? pick(ok, "totalMs"),
              loadMs: pick(ok, "loadMs"),
              storedMiB: ok[0]?.size
                ? +(ok[0].size.bytes / 2 ** 20).toFixed(1)
                : null,
            },
          ]
        })
      ),
    ])
  )
  const file = join(
    resultDirectory,
    `large-${new Date().toISOString().replaceAll(":", "-")}.json`
  )
  await writeFile(
    file,
    JSON.stringify(
      {
        schema: 1,
        mode: "node-memory-large",
        smoke,
        runs,
        results,
        largeSummary,
      },
      null,
      2
    ) + "\n"
  )
  console.table(
    Object.entries(largeSummary).flatMap(([key, byTarget]) =>
      Object.entries(byTarget).map(([target, value]) => ({
        case: key,
        target,
        ...value,
      }))
    )
  )
  for (const [name, result] of Object.entries(results))
    for (const [label, rss] of Object.entries(result.maxRss))
      console.log(`${name} ${label} peak RSS ${(rss / 2 ** 20).toFixed(0)} MiB`)
  console.log(`Saved ${file}`)
  process.exit(0)
}
const importHashes = new Set(
  Object.values(results).map(r => r.importFixtureSha256)
)
if (importHashes.size !== 1) throw new Error("Import fixture hashes differ")
const mixedHashes = new Set(
  Object.values(results).map(r => r.mixed.fixtureSha256)
)
if (mixedHashes.size !== 1) throw new Error("Mixed fixture hashes differ")
const counts = smoke ? [10] : [10, 100, 500, 1000]
const summary = Object.fromEntries(
  counts.map(count => [
    count,
    Object.fromEntries(
      names.map(name => {
        const values = results[name].samples
          .filter(s => s.count === count)
          .map(s => s.totalMs)
        return [
          name,
          {
            medianMs: median(values),
            minMs: Math.min(...values),
            maxMs: Math.max(...values),
          },
        ]
      })
    ),
  ])
)
const mixedSummary = Object.fromEntries(
  (smoke ? [50] : [100, 500, 1000]).map(count => [
    count,
    Object.fromEntries(
      names.map(name => {
        const samples = results[name].mixed.samples.filter(
          s => s.count === count
        )
        const values = samples.map(s => s.totalMs)
        const buckets = [
          ...new Set(samples.flatMap(s => Object.keys(s.buckets))),
        ]
        return [
          name,
          {
            medianMs: median(values),
            minMs: Math.min(...values),
            maxMs: Math.max(...values),
            p95Ms: median(samples.map(s => s.p95Ms)),
            bucketP95Ms: Object.fromEntries(
              buckets.map(bucket => [
                bucket,
                median(samples.map(s => s.buckets[bucket].p95Ms)),
              ])
            ),
            keys: results[name].mixed.seed.keys,
            bytes: results[name].mixed.seed.bytes,
          },
        ]
      })
    ),
  ])
)
const writeSummary = Object.fromEntries(
  ["creates", "burst"].map(kind => [
    kind,
    Object.fromEntries(
      names.map(name => {
        const samples = results[name].writes[kind]
        const percentile = values =>
          [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]
        const pick = key => {
          const values = samples.map(sample => sample[key])
          return {
            median: median(values),
            min: Math.min(...values),
            max: Math.max(...values),
          }
        }
        return [
          name,
          {
            count: samples[0].count,
            submitMs: pick("submitMs"),
            drainMs: pick("drainMs"),
            totalMs: pick("totalMs"),
            opsPerSecond: pick("opsPerSecond"),
            callP95Ms: median(samples.map(sample => percentile(sample.callMs))),
            verified: samples.every(sample => sample.verified),
          },
        ]
      })
    ),
  ])
)
const importSummary = Object.fromEntries(
  [
    ...new Set(
      Object.values(results).flatMap(result =>
        result.imports.map(s => s.fixture)
      )
    ),
  ].map(fixture => [
    fixture,
    Object.fromEntries(
      names.map(name => {
        const samples = results[name].imports.filter(s => s.fixture === fixture)
        const failures = samples.filter(s => !s.verified).length
        const pick = key => (failures ? null : median(samples.map(s => s[key])))
        return [
          name,
          {
            records: samples[0].records,
            samples: samples.length,
            failures,
            importMs: pick("importMs"),
            flushMs: pick("flushMs"),
          },
        ]
      })
    ),
  ])
)
const historySummary = Object.fromEntries(
  names.map(name => {
    const samples = results[name].history
    const pick = key => {
      const values = samples.map(sample => sample[key])
      return {
        median: median(values),
        min: Math.min(...values),
        max: Math.max(...values),
      }
    }
    const { stored } = samples[0]
    return [
      name,
      {
        edits: samples[0].edits,
        writeMs: pick("writeMs"),
        loadMs: pick("loadMs"),
        keys: stored.keys,
        bytes: stored.bytes,
        commits: stored.commits,
        fragments: stored.fragments,
        verified: samples.every(sample => sample.verified),
      },
    ]
  })
)
const report = {
  schema: 5,
  mode: "node-memory-load-write",
  smoke,
  runs,
  results,
  summary,
  mixedSummary,
  writeSummary,
  historySummary,
  importSummary,
}
const file = join(
  resultDirectory,
  `comparison-${new Date().toISOString().replaceAll(":", "-")}.json`
)
await writeFile(file, JSON.stringify(report, null, 2) + "\n")
console.log(JSON.stringify(summary, null, 2))
console.log(JSON.stringify(mixedSummary, null, 2))
console.log(JSON.stringify(writeSummary, null, 2))
console.log(JSON.stringify(historySummary, null, 2))
console.log(JSON.stringify(importSummary, null, 2))
console.log(`Saved ${file}`)
