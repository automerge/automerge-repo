// Times each step of storing a large delta on the current branch, outside
// Repo, so costs can be attributed. Usage:
//   node examples/node-benchmark/large-phases.mjs [--shape=records,json,text]
//     [--mib=8,32] [--basis=changes|saved] [--parts=64]
// eslint-disable-next-line no-restricted-imports
import * as A from "@automerge/automerge"
import {
  extractFragments,
  extractNewCommits,
  extractRecords,
  isBoundary,
} from "@automerge/automerge-repo/sedimentree/automerge"
import { performance } from "node:perf_hooks"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import {
  largeInitial,
  largeParts,
  largeShapes,
  largeUnits,
} from "../browser-benchmark/src/large.ts"

const option = (name, fallback) =>
  process.argv
    .find(arg => arg.startsWith(`--${name}=`))
    ?.slice(name.length + 3)
    .split(",") ?? fallback
const shapes = option("shape", largeShapes)
const sizes = option("mib", ["8", "32"]).map(Number)
const parts = Number(option("parts", ["64"])[0])
// "changes" sizes by encoded change bytes, "saved" by saved document size.
const basis = option("basis", ["changes"])[0]
const api = { ImmutableString: A.ImmutableString, splice: A.splice }
const actor = "1".padStart(32, "0")

function time(fn) {
  const start = performance.now()
  const value = fn()
  return [performance.now() - start, value]
}

function build(plan) {
  const before = A.from(largeInitial(plan), { actor })
  let after = A.clone(before)
  const [ms] = time(() => {
    for (const mutate of largeParts(plan, api))
      after = A.change(after, { time: 0 }, mutate)
  })
  return { before, after, ms }
}

// Candidate replacements for `extractNewCommits`.
const variants = {
  // Metadata paired with blobs by index: same internal order upstream.
  meta(before, after) {
    const heads = A.getHeads(before)
    const blobs = A.getChangesSince(after, heads)
    const meta = A.getChangesMetaSince(after, heads)
    if (meta.length !== blobs.length) throw new Error("length mismatch")
    return blobs.map((blob, i) => ({
      kind: "commit",
      id: meta[i].hash,
      parents: [...new Set(meta[i].deps)].sort(),
      blob: new Uint8Array(blob),
    }))
  },
}

// Each case runs in its own process: Automerge can exhaust its WASM memory
// (and then refuses every later call), so a crash must only end its own case.
// Steps report as they finish; risky ones (full decodes) run last.
const single = option("case", null)?.[0]
// Steps to leave out, e.g. --skip=diff when it exhausts memory first.
const skip = option("skip", [])
if (!single) {
  const rows = []
  for (const shape of shapes)
    for (const mib of sizes)
      for (const count of [1, parts]) {
        const child = spawnSync(
          process.execPath,
          [
            ...process.execArgv,
            fileURLToPath(import.meta.url),
            `--case=${shape}:${mib}:${count}`,
            `--basis=${basis}`,
            `--skip=${skip.join(",")}`,
          ],
          { encoding: "utf8", maxBuffer: 1 << 26 }
        )
        const row = { shape, mib, basis, changes: count }
        for (const line of child.stdout.split("\n"))
          if (line.startsWith("STEP "))
            Object.assign(row, JSON.parse(line.slice(5)))
        if (child.status !== 0) {
          const reason = /rust_oom|out of memory/i.test(child.stderr)
            ? "out of memory"
            : (child.stderr.match(/(\w*Error[^\n]*)/)?.[1] ??
              `exit ${child.status}`)
          row.failed = `${row.next ?? "?"}: ${reason}`
        }
        delete row.next
        rows.push(row)
        console.log(
          Object.entries(row)
            .map(
              ([k, v]) => `${k}=${typeof v === "number" ? +v.toFixed(2) : v}`
            )
            .join(" ")
        )
      }
  if (process.argv.includes("--json")) console.log(JSON.stringify(rows))
  process.exit(0)
}

const [shape, mib, count] = single.split(":")
const plan = { shape, mib: Number(mib), basis, parts: Number(count), seed: 1 }
const report = values => console.log(`STEP ${JSON.stringify(values)}`)
function step(name, fn) {
  if (skip.includes(name)) return undefined
  report({ next: name })
  const [ms, value] = time(fn)
  report({ [`${name}Ms`]: ms })
  return value
}
report({ units: largeUnits(plan), next: "build" })
const { before, after, ms: buildMs } = build(plan)
report({ buildMs })
const heads = A.getHeads(before)
const afterHeads = A.getHeads(after)
const blobs = step("since", () => A.getChangesSince(after, heads))
report({
  changeMiB: +(blobs.reduce((n, b) => n + b.length, 0) / 2 ** 20).toFixed(2),
})
step("meta", () => A.getChangesMetaSince(after, heads))
step("saveSince", () => A.saveSince(after, heads))
const metaCommits = step("metaVariant", () => variants.meta(before, after))
const boundaries = metaCommits.filter(c => isBoundary(c.id)).map(c => c.id)
report({ boundaries: boundaries.length })
step("fragments", () => extractFragments(after, boundaries))
const records = step("records", () => extractRecords(after))
report({ records: records.length })
const patches = step("diff", () => A.diff(after, heads, afterHeads))
report({ patches: patches?.length })
const saved = step("save", () => A.save(after))
report({ snapshotMiB: +(saved.length / 2 ** 20).toFixed(2) })
step("load", () => A.load(saved))
step("decode", () => blobs.map(blob => A.decodeChange(blob)))
const commits = step("current", () => extractNewCommits(before, after))
if (
  metaCommits.some(
    (commit, i) =>
      commit.id !== commits[i].id ||
      commit.parents.join() !== commits[i].parents.join()
  )
)
  throw new Error("meta variant disagrees with decodeChange")
report({ next: undefined })
