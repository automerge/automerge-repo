import { $ } from "execa"
import path from "path"
import os from "os"
import fs from "fs"
import { exit } from "node:process"

// Smoke test: pack create-repo-node-app, scaffold an app in a temp directory,
// install it, run it, and confirm it creates a document.

console.log("building create-repo-node-app...")
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

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-create-node-"))
const $$ = $({ cwd: tempDir })

console.log("creating test app...")
await $$`pnpm init`
await $$`pnpm install ${tarballPath}`
await $$`./node_modules/@automerge/create-repo-node-app/dist/index.js test-app`

const cwd = path.join(tempDir, "test-app")
const $$$ = $({ cwd })

console.log("installing test app...")
// pnpm 11 gates optional native build scripts (e.g. cbor-extract via cbor-x)
// pending approval and exits non-zero; dependencies still install and the demo
// runs without that optional build, so don't treat the gate as a failure.
await $$$`pnpm install`.catch(() => {})

console.log("running test app...")
// Run index.ts directly (rather than via `pnpm start`) so the timeout kills the
// node process cleanly instead of orphaning it. The app stays alive to keep
// syncing, so the timeout stops it after it has logged the document URL.
const output = await $$$({ timeout: 8000 })`node index.ts`.catch(
  result => result.stdout
)

const success = output.includes("Created document")

// cleanup (the tarball is gitignored, so `git clean -f` alone would skip it)
await fs.promises.rm(tarballPath, { force: true })

if (success) {
  console.log("✅ create-repo-node-app test passed")
  exit(0)
} else {
  console.log()
  console.log(output)
  console.log()
  console.log("❌ create-repo-node-app test failed")
  exit(1)
}
