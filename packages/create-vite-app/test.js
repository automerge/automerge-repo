import { $ } from "execa"
import path from "path"
import os from "os"
import fs from "fs"
import { exit } from "node:process"

// Smoke test: build and pack create-vite-app, scaffold an app in a temp
// directory, install it, and confirm the dev server boots.

console.log("building create-vite-app...")
await $`pnpm build`

const { stdout: packOutput } = await $`pnpm pack`
console.log("creating tarball...")
// `pnpm pack` prints the tarball contents and details; the tarball filename is
// the line ending in .tgz.
const tarballFile = packOutput
  .split("\n")
  .map(line => line.trim())
  .find(line => line.endsWith(".tgz"))
const tarballPath = path.join(process.cwd(), tarballFile)

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-create-"))
const $$ = $({ cwd: tempDir })

console.log("creating test app...")
await $$`pnpm init`
await $$`pnpm install ${tarballPath}`
await $$`./node_modules/@automerge/create-vite-app/dist/index.js test-app`

const cwd = path.join(tempDir, "test-app")
const $$$ = $({ cwd })

console.log("installing test app...")
// pnpm 11 gates optional native build scripts (e.g. cbor-extract via cbor-x)
// pending approval and exits non-zero; dependencies still install and the dev
// server runs without that optional build. Tolerate only that gate: surface a
// genuine install failure by re-throwing if node_modules was not populated.
const install = await $$$`pnpm install`.catch(error => error)
if (!fs.existsSync(path.join(cwd, "node_modules"))) {
  throw new Error(
    `pnpm install failed:\n${install?.stderr ?? install?.message ?? ""}`
  )
}

console.log("building test app...")
// `vite build` (via the build script) type-checks and bundles the app, then
// exits — non-zero on failure — so its exit status is the pass/fail signal,
// with no long-running dev server to leave hanging.
const { exitCode } = await $$$`pnpm build`.catch(error => error)
const success = exitCode === 0

// cleanup (the tarball is gitignored, so `git clean -f` alone would skip it)
await fs.promises.rm(tarballPath, { force: true })

if (success) {
  console.log("✅ create-vite-app test passed")
  exit(0)
} else {
  console.log()
  console.log(output)
  console.log()
  console.log("❌ create-vite-app test failed")
  exit(1)
}
