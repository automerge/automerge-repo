// The bundled packages must ship their own source and nothing else. An inlined
// dependency is delivered twice, once bundled and once installed, and for
// anything identity-bearing the two copies are not interchangeable. #660 tried
// to fix this with externals matched on import specifiers, which does not catch
// a workspace sibling because vite resolves it to a path first.
//
// The sourcemap lists every file that contributed to the bundle, so use that
// rather than scanning for inlined module markers: rolldown emits no //#region
// for some inlined packages.
import { readFileSync, existsSync } from "node:fs"

const BUNDLED = [
  "packages/automerge-repo-react-hooks",
  "packages/automerge-repo-solid-primitives",
]

type SourceMap = { sources?: string[] }

let failed = false
for (const pkg of BUNDLED) {
  const map = `${pkg}/dist/index.js.map`
  if (!existsSync(map)) {
    console.error(`${map}: not built, run pnpm build first`)
    failed = true
    continue
  }
  const sourceMap: SourceMap = JSON.parse(readFileSync(map, "utf8"))
  const sources = sourceMap.sources ?? []
  const foreign = sources.filter(
    s => s.includes("node_modules") || s.startsWith("../../")
  )
  if (foreign.length > 0) {
    console.error(`${pkg} bundles code from outside its own source:`)
    for (const s of foreign) console.error(`  ${s}`)
    failed = true
  }
}
if (failed) process.exit(1)
