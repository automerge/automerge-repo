import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  prepare,
  readIndex,
  command,
  root,
} from "../browser-benchmark/prepare.mjs"

const directory = fileURLToPath(new URL(".", import.meta.url))
const smoke = process.argv.includes("--smoke")
const profile = process.argv.includes("--profile")
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
    const args = [
      join(directory, "load.mjs"),
      JSON.stringify({
        target: name,
        directory: info?.path,
        runs,
        smoke,
        output,
        profile: profile
          ? join(
              resultDirectory,
              `${name}-${new Date().toISOString().replaceAll(":", "-")}.cpuprofile`
            )
          : null,
      }),
    ]
    execFileSync(process.execPath, args, {
      cwd: directory,
      stdio: "inherit",
      env: process.env,
    })
    results[name] = {
      ...JSON.parse(await readFile(output, "utf8")),
      revision: info?.sha ?? command("git", ["rev-parse", "HEAD"]),
    }
  }
} finally {
  await rm(temp, { recursive: true, force: true })
}
const hashes = new Set(Object.values(results).map(r => r.fixtureSha256))
if (hashes.size !== 1) throw new Error("Fixture hashes differ")
const counts = smoke ? [10] : [10, 100, 500, 1000]
const median = values =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
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
const report = {
  schema: 1,
  mode: "node-memory-load",
  smoke,
  runs,
  results,
  summary,
}
const file = join(
  resultDirectory,
  `comparison-${new Date().toISOString().replaceAll(":", "-")}.json`
)
await writeFile(file, JSON.stringify(report, null, 2) + "\n")
console.log(JSON.stringify(summary, null, 2))
console.log(`Saved ${file}`)
