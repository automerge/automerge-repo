import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path, { dirname } from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PROFILE_DIR = path.join(REPO_ROOT, "profiles")
const CHART_PATH = path.join(PROFILE_DIR, "chart.html")
const HARNESS = "packages/automerge-repo/test/memoryProfile.sync-server.test.ts"

/** x axis for every chart: cumulative documents the workload has created. */
const X_KEY = "totalDocsCreated"
const X_LABEL = "documents created (cumulative)"

const METRICS = [
  { key: "heapUsedMB", title: "JS heap after GC", axis: "MB" },
  { key: "rssMB", title: "Resident set size", axis: "MB" },
  {
    key: "serverDocsInMemory",
    title: "Documents held in server memory",
    axis: "documents",
  },
  {
    key: "serverDocSynchronizers",
    title: "Document synchronizers",
    axis: "synchronizers",
  },
]

const usage = `Usage:
  memory-profile.ts collect
  memory-profile.ts compare <ref> <ref> [<ref>...]
  memory-profile.ts chart
  memory-profile.ts help

Run the sync-server memory profile harness and chart what it samples. Sample
files and the chart go in ./profiles, which is not tracked.

Commands:
  collect
    Run the harness against the working tree. Writes one sample file, named
    for the current branch and tip commit.

  compare <ref> <ref> [<ref>...]
    Run the harness against each ref, then redraw the chart. Each ref gets its
    own Git worktree and the harness is copied in from the invoking tree, so
    one harness runs against every library. Checking the refs out in turn
    would instead pair each ref's harness with its own library.

    Each worktree installs the dependencies its own ref pins, so a ref is
    measured against the versions it ships with. The harness is restricted to
    API every compared ref has; a ref that lacks it fails the run.

  chart
    Redraw profiles/chart.html from every sample file in profiles/. Data and
    Chart.js are inlined, so the page needs no network.

  help, --help, -h
    Show this help text.`

type Sample = Record<string, number>

type HarnessOutput = {
  meta: Record<string, number>
  samples: Sample[]
}

type Provenance = {
  label: string
  ref: string
  commit: string
}

type Profile = HarnessOutput & Provenance & { collectedAt: string }

function main([command, ...args]: string[]) {
  switch (command) {
    case "help":
    case "--help":
    case "-h":
      if (args.length !== 0) throw new Error(usage)
      console.log(usage)
      return
    case "collect":
      return collect(args)
    case "compare":
      return compare(args)
    case "chart":
      return chart(args)
    default:
      throw new Error(usage)
  }
}

function collect(args: string[]) {
  if (args.length !== 0) throw new Error(usage)
  const commit = git(["rev-parse", "HEAD"])
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"])
  const ref = branch === "HEAD" ? short(commit) : branch
  const dirty = git(["status", "--porcelain"]) !== ""
  runHarness(REPO_ROOT, {
    ref,
    commit,
    label: `${ref}@${short(commit)}${dirty ? "+dirty" : ""}`,
  })
}

function compare(refs: string[]) {
  if (refs.length < 2) throw new Error(usage)
  // Up front: a run is minutes per ref, too long to find out the last one was
  // a typo.
  const targets = refs.map(ref => ({ ref, commit: resolve(ref) }))
  const harness = readFileSync(path.join(REPO_ROOT, HARNESS), "utf8")

  for (const { ref, commit } of targets) {
    const parent = mkdtempSync(path.join(tmpdir(), "automerge-repo-profile-"))
    const tree = path.join(parent, "tree")
    try {
      git(["worktree", "add", "--detach", tree, commit])
      install(tree, ref)
      mkdirSync(dirname(path.join(tree, HARNESS)), { recursive: true })
      writeFileSync(path.join(tree, HARNESS), harness)
      runHarness(tree, { ref, commit, label: `${ref}@${short(commit)}` })
    } finally {
      spawnSync("git", ["worktree", "remove", "--force", tree], {
        cwd: REPO_ROOT,
      })
      rmSync(parent, { recursive: true, force: true })
      spawnSync("git", ["worktree", "prune"], { cwd: REPO_ROOT })
    }
  }

  chart([])
}

function chart(args: string[]) {
  if (args.length !== 0) throw new Error(usage)
  const profiles = readProfiles()
  if (profiles.length === 0) {
    throw new Error(`No sample files in ${PROFILE_DIR}. Run collect first.`)
  }
  writeFileSync(CHART_PATH, renderChart(profiles))
  console.log(CHART_PATH)
}

/**
 * Install what the ref itself pins. One node_modules shared across refs would
 * measure every ref against the invoking tree's versions, and the automerge
 * core they pin is most of what this profiles.
 */
function install(tree: string, ref: string) {
  const result = spawnSync("pnpm", ["install", "--frozen-lockfile"], {
    cwd: tree,
    stdio: "inherit",
  })
  if (result.status !== 0) throw new Error(`pnpm install failed for ${ref}.`)
}

/**
 * Run the harness in `cwd` and write its samples, with the provenance of the
 * code they describe, to a sample file named after the label.
 *
 * --expose-gc goes on unconditionally: the harness needs globalThis.gc and not
 * every ref wires up vitest's execArgv.
 */
function runHarness(cwd: string, provenance: Provenance) {
  const vitest = path.join(cwd, "node_modules", ".bin", "vitest")
  if (!existsSync(vitest)) {
    throw new Error(`${vitest} is missing. Run pnpm install.`)
  }

  const scratch = mkdtempSync(path.join(tmpdir(), "automerge-repo-samples-"))
  const samplePath = path.join(scratch, "samples.json")
  try {
    const result = spawnSync(vitest, ["run", HARNESS], {
      cwd,
      stdio: "inherit",
      env: {
        ...process.env,
        MEMORY_PROFILE: samplePath,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, "--expose-gc"]
          .filter(Boolean)
          .join(" "),
      },
    })
    if (result.status !== 0) {
      throw new Error(`The harness failed for ${provenance.label}.`)
    }
    const output = JSON.parse(readFileSync(samplePath, "utf8")) as HarnessOutput
    const profile: Profile = {
      ...provenance,
      collectedAt: new Date().toISOString(),
      ...output,
    }
    mkdirSync(PROFILE_DIR, { recursive: true })
    const file = path.join(PROFILE_DIR, `${fileSafe(provenance.label)}.json`)
    writeFileSync(file, JSON.stringify(profile, null, 2))
    console.log(file)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

function readProfiles(): Profile[] {
  if (!existsSync(PROFILE_DIR)) return []
  return readdirSync(PROFILE_DIR)
    .filter(name => name.endsWith(".json"))
    .sort()
    .map(
      name =>
        JSON.parse(
          readFileSync(path.join(PROFILE_DIR, name), "utf8")
        ) as Profile
    )
}

function renderChart(profiles: Profile[]) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sync-server memory profile</title>
<style>
  :root { color-scheme: light; }
  body {
    margin: 0 auto; padding: 24px 16px 48px; max-width: 1100px;
    background: #ffffff; color: #1f2933;
    font: 14px/1.5 ui-sans-serif, -apple-system, "Segoe UI", Helvetica, sans-serif;
  }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 14px; margin: 0 0 8px; font-weight: 600; }
  p { margin: 0 0 16px; color: #5b6b7a; }
  #warning { color: #c2483b; font-weight: 600; }
  .grid {
    display: grid; gap: 20px;
    grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
  }
  .card { border: 1px solid #e3e8ee; border-radius: 8px; padding: 16px; }
  .plot { height: 260px; }
  table { border-collapse: collapse; margin-top: 24px; width: 100%; }
  caption { text-align: left; font-weight: 600; padding-bottom: 8px; }
  th, td { border-bottom: 1px solid #e3e8ee; padding: 6px 10px; text-align: right; }
  th:first-child, td:first-child { text-align: left; }
  td.swatch { border-left: 4px solid transparent; }
  code { font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
</style>
</head>
<body>
<h1>Sync-server memory profile</h1>
<p id="workload"></p>
<p id="warning" hidden></p>
<div class="grid" id="charts"></div>
<table id="summary"><caption>Final round</caption></table>
<script type="application/json" id="profile-data">${embed(profiles)}</script>
<script type="application/json" id="metric-data">${embed(METRICS)}</script>
<script type="application/json" id="axis-data">${embed({
    key: X_KEY,
    label: X_LABEL,
  })}</script>
<script>${chartJs()}</script>
<script>
${pageScript()}
</script>
</body>
</html>
`
}

/**
 * The Chart.js bundle, inlined so the page draws without a network, minus the
 * source map, which is not inlined with it. The UMD build is not an export of
 * the package, so reach it through the entry beside it.
 */
function chartJs() {
  const umd = path.join(
    dirname(createRequire(import.meta.url).resolve("chart.js")),
    "chart.umd.min.js"
  )
  return readFileSync(umd, "utf8").replace(/\s*\/\/# sourceMappingURL=\S+/, "")
}

/** Inline JSON in a script element, out of reach of the HTML parser. */
function embed(value: unknown) {
  return JSON.stringify(value).replace(/</g, "\\u003c")
}

function pageScript() {
  return `const read = id => JSON.parse(document.getElementById(id).textContent)
const profiles = read("profile-data")
const metrics = read("metric-data")
const axis = read("axis-data")
const palette = ["#2f6faf", "#c2483b", "#2e7d5b", "#b07a12", "#6b4c9a", "#3e7c8c"]
const color = i => palette[i % palette.length]
const last = profile => profile.samples[profile.samples.length - 1]

const workload = Object.entries(profiles[0].meta)
  .map(entry => entry[0] + " " + entry[1])
  .join(", ")
document.getElementById("workload").textContent = workload

const shape = profile => JSON.stringify(profile.meta)
const mismatched = profiles.filter(p => shape(p) !== shape(profiles[0]))
if (mismatched.length > 0) {
  const warning = document.getElementById("warning")
  warning.hidden = false
  warning.textContent =
    "Collected under different workload parameters, not comparable: " +
    mismatched.map(p => p.label).join(", ")
}

Chart.defaults.font.family = getComputedStyle(document.body).fontFamily
Chart.defaults.color = "#5b6b7a"

for (const metric of metrics) {
  const card = document.createElement("div")
  card.className = "card"
  const heading = document.createElement("h2")
  heading.textContent = metric.title
  const plot = document.createElement("div")
  plot.className = "plot"
  const canvas = document.createElement("canvas")
  plot.append(canvas)
  card.append(heading, plot)
  document.getElementById("charts").append(card)

  new Chart(canvas, {
    type: "line",
    data: {
      datasets: profiles.map((profile, i) => ({
        label: profile.label,
        borderColor: color(i),
        backgroundColor: color(i),
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.15,
        data: profile.samples.map(s => ({ x: s[axis.key], y: s[metric.key] })),
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      // Off so a screenshot of the page is never taken mid-transition.
      animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { position: "bottom" } },
      scales: {
        x: {
          type: "linear",
          title: { display: true, text: axis.label },
          grid: { color: "#eef1f5" },
        },
        y: {
          beginAtZero: true,
          title: { display: true, text: metric.axis },
          grid: { color: "#eef1f5" },
        },
      },
    },
  })
}

const summary = document.getElementById("summary")
const head = summary.insertRow()
for (const title of ["profile", "commit", axis.label].concat(metrics.map(m => m.title))) {
  const cell = document.createElement("th")
  cell.textContent = title
  head.append(cell)
}
profiles.forEach((profile, i) => {
  const row = summary.insertRow()
  const sample = last(profile)
  const name = row.insertCell()
  name.textContent = profile.label
  name.className = "swatch"
  name.style.borderLeftColor = color(i)
  const commit = row.insertCell()
  const code = document.createElement("code")
  code.textContent = profile.commit.slice(0, 8)
  commit.append(code)
  for (const key of [axis.key].concat(metrics.map(m => m.key))) {
    row.insertCell().textContent = sample[key]
  }
})`
}

function git(args: string[]) {
  const result = spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" })
  if (result.status === null && result.error) {
    throw new Error(`Could not run git: ${result.error.message}`)
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim()
    throw new Error(detail || `git ${args.join(" ")} failed`)
  }
  return result.stdout.trim()
}

/** git names no ref in its own message for an unresolvable one. */
function resolve(ref: string) {
  try {
    return git(["rev-parse", "--verify", `${ref}^{commit}`])
  } catch {
    throw new Error(`Cannot resolve ref "${ref}".`)
  }
}

const short = (commit: string) => commit.slice(0, 8)

const fileSafe = (label: string) => label.replace(/[^\w.@+-]+/g, "-")

try {
  main(process.argv.slice(2))
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
