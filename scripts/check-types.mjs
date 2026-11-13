// Type-checks the projects `tsc --noEmit` over each package's sources does not
// reach: compile-time check files and tests. Some read built packages, so run
// after `pnpm build`.
import { spawnSync } from "node:child_process"
import path, { dirname } from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const PROJECTS = [
  "packages/automerge-repo/test/tsconfig.checks.json",
  "packages/automerge-repo-subduction/test/tsconfig.json",
  "packages/automerge-react/test/tsconfig.types.json",
  "packages/automerge-repo-solid-primitives/tsconfig.test.json",
  "packages/automerge-repo-solid-primitives/test/types/tsconfig.types.json",
  "packages/automerge-repo-svelte-store/test/types/tsconfig.types.json",
]

let failed = 0
for (const project of PROJECTS) {
  const result = spawnSync(
    "pnpm",
    ["exec", "tsc", "--noEmit", "-p", path.join(REPO_ROOT, project)],
    { cwd: REPO_ROOT, stdio: "inherit" }
  )
  if (result.status !== 0) {
    console.error(`Type check failed: ${project}`)
    failed++
  }
}
process.exit(failed ? 1 : 0)
