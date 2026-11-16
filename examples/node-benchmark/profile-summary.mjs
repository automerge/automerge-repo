// Prints self and inclusive time per function from a .cpuprofile.
//   node examples/node-benchmark/profile-summary.mjs <file.cpuprofile> [--top=25]
import { readFile } from "node:fs/promises"
import { basename } from "node:path"

const file = process.argv[2]
const top = Number(
  process.argv.find(arg => arg.startsWith("--top="))?.slice(6) ?? 25
)
const { nodes, samples, timeDeltas, startTime, endTime } = JSON.parse(
  await readFile(file, "utf8")
)
const byId = new Map(nodes.map(node => [node.id, node]))
const parent = new Map()
for (const node of nodes)
  for (const child of node.children ?? []) parent.set(child, node.id)
const label = ({ callFrame: f }) =>
  `${f.functionName || "(anonymous)"} ${f.url ? `${basename(f.url)}:${f.lineNumber + 1}` : ""}`.trim()

const self = new Map()
const inclusive = new Map()
for (let i = 0; i < samples.length; i++) {
  const ms = (timeDeltas[i + 1] ?? 0) / 1000
  let id = samples[i]
  const key = label(byId.get(id))
  self.set(key, (self.get(key) ?? 0) + ms)
  // Count each function once per sample, however deep the recursion.
  const seen = new Set()
  while (id !== undefined) {
    const name = label(byId.get(id))
    if (!seen.has(name)) {
      seen.add(name)
      inclusive.set(name, (inclusive.get(name) ?? 0) + ms)
    }
    id = parent.get(id)
  }
}
const total = (endTime - startTime) / 1000
const print = (title, map) => {
  console.log(`\n${title} (of ${total.toFixed(0)} ms)`)
  for (const [name, ms] of [...map].sort((a, b) => b[1] - a[1]).slice(0, top))
    console.log(
      `${ms.toFixed(0).padStart(8)} ms ${((100 * ms) / total).toFixed(1).padStart(5)}%  ${name}`
    )
}
print("Self time", self)
print("Inclusive time", inclusive)
