import { readFile, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { directory, command, prepare, readIndex, root } from "./prepare.mjs"

const smoke = process.argv.includes("--smoke")
const reseed = process.argv.includes("--reseed")
const runs = Number(
  process.argv.find(arg => arg.startsWith("--runs="))?.slice(7) ?? 3
)
if (!Number.isSafeInteger(runs) || runs < 1)
  throw new Error("--runs must be a positive integer")
const names = process.argv.slice(2).filter(arg => !arg.startsWith("--"))
if (!names.length) names.push("main", "subductionjs", "poc")
if (!names.includes("main"))
  throw new Error("Comparison requires main as baseline")
const results = {}
const file = join(directory, "results", "comparison-current.json")
await mkdir(join(directory, "results"), { recursive: true })

for (let round = 0; round < runs; round++) {
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
      throw new Error(
        `Unknown target ${name}; run bench:prepare name=ref:adapter`
      )
    const env = {
      ...process.env,
      BENCH_NAME: name,
      VITE_BENCH_NAME: name,
      VITE_BENCH_COMMIT: info?.sha ?? command("git", ["rev-parse", "HEAD"]),
      BENCH_ADAPTER: info?.adapter ?? "poc",
      BENCH_TARGET_DIR: info?.path ?? "",
      BENCH_RESULT_FILE: file,
    }
    console.log(
      `Round ${round + 1}/${runs}: ${name} ${info?.sha ?? command("git", ["rev-parse", "HEAD"])}`
    )
    command(
      "pnpm",
      [
        "--filter",
        "@automerge/automerge-repo-browser-benchmark",
        "automate",
        ...(smoke ? ["--smoke"] : []),
        ...(reseed && round === 0 ? ["--reseed"] : []),
      ],
      root,
      env
    )
    ;(results[name] ??= []).push(JSON.parse(await readFile(file, "utf8")))
    if (!results[name].at(-1).edits?.verified)
      console.warn(
        `${name} persistence incomplete; load and edit-call samples still available`
      )
  }
}

const median = values =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const series = (name, pick) => results[name].map(pick)
const metrics = {}
for (const count of smoke ? [10] : [10, 100, 500, 1000]) {
  metrics[`load${count}Ms`] = r =>
    r.loads.find(load => load.count === count).totalMs
  metrics[`load${count}P95Ms`] = r =>
    r.loads.find(load => load.count === count).p95Ms
  metrics[`load${count}WorstFrameMs`] = r =>
    Math.max(...r.loads.find(load => load.count === count).frameGapMs)
}
// Import classes come from the result itself so older reports (no imports)
// compare as null rather than throwing. A class with any failed sample is null.
const importClasses = new Set(
  Object.values(results)
    .flat()
    .flatMap(r => (r.imports ?? []).map(entry => entry.fixture))
)
for (const fixture of importClasses) {
  const entry = r => (r.imports ?? []).find(item => item.fixture === fixture)
  metrics[`import_${fixture}P50Ms`] = r =>
    entry(r)?.failures === 0 ? entry(r).importP50Ms : null
  metrics[`import_${fixture}FlushP50Ms`] = r =>
    entry(r)?.failures === 0 ? entry(r).flushP50Ms : null
  metrics[`import_${fixture}Failures`] = r => entry(r)?.failures ?? null
}
metrics.editCallP95Ms = r =>
  [...r.edits.callMs].sort((a, b) => a - b)[
    Math.ceil(r.edits.callMs.length * 0.95) - 1
  ]
metrics.worstFrameMs = r => Math.max(...r.edits.frameGapMs)
metrics.drainMs = r => (r.edits.verified ? r.edits.drainMs : null)

const summary = {}
const fixtureHashes = new Set(
  Object.values(results)
    .flat()
    .map(result => result.fixtureSha256)
)
if (fixtureHashes.size !== 1)
  throw new Error("Fixture manifests differ across targets")
const importHashes = new Set(
  Object.values(results)
    .flat()
    .map(result => result.importFixtureSha256 ?? null)
)
if (importHashes.size !== 1)
  throw new Error("Import fixture manifests differ across targets")
for (const [key, pick] of Object.entries(metrics)) {
  const baselineValues = series("main", pick)
  const baseline = baselineValues.every(value => value !== null)
    ? median(baselineValues)
    : null
  summary[key] = Object.fromEntries(
    names.map(name => {
      const values = series(name, pick)
      const complete = values.every(value => value !== null)
      const value = complete ? median(values) : null
      return [
        name,
        {
          samples: values,
          median: value,
          min: complete ? Math.min(...values) : null,
          max: complete ? Math.max(...values) : null,
          vsMainPercent:
            baseline && value !== null && !key.endsWith("Failures")
              ? (value / baseline - 1) * 100
              : null,
        },
      ]
    })
  )
}
const output = {
  schema: 1,
  baseline: "main",
  rounds: runs,
  smoke,
  targets: Object.fromEntries(
    names.map(name => [
      name,
      results[name].map(r => ({
        revision: r.revision,
        adapter: r.target.adapter,
        fixtureSha256: r.fixtureSha256,
        seed: r.seed,
      })),
    ])
  ),
  summary,
}
const name = `comparison-${smoke ? "smoke-" : ""}${new Date().toISOString().replaceAll(":", "-")}.json`
await writeFile(
  join(directory, "results", name),
  JSON.stringify(output, null, 2) + "\n"
)
console.log(`Saved examples/browser-benchmark/results/${name}`)
