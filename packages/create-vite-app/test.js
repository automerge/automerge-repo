import { execa } from "execa"
import { $ } from "execa"
import path from "path"
import os from "os"
import fs from "fs"
import { exit } from "node:process"

// This script is used to test the create-vite-app script from local code in a temporary directory
// see https://github.com/automerge/automerge-repo/pull/322#issuecomment-2012354463 for context

// build

const { stdout } = await execa("pnpm", ["run", "build"])

console.log("building create-vite-app...")
await $`pnpm build`

// pack

const { stdout: tarballFile } = await $`pnpm pack`
console.log("creating tarball...")
const tarballPath = path.join(process.cwd(), tarballFile)

// create a temp dir and test the create-vite-app script by creating an app

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-create-"))

const $$ = $({ cwd: tempDir })

console.log("creating test app...")
await $$`pnpm init`
await $$`pnpm install ${tarballPath}`
await $$`./node_modules/@automerge/create-vite-app/dist/index.js test-app`

// run the app in dev mode

const cwd = path.join(tempDir, "test-app")
const $$$ = $({ cwd })

console.log("installing test app...")
await $$$`pnpm install`

console.log("running test app in dev mode...")

// `vite` is a long running command, so we abuse the `timeout` to kill it after a short time.
// This throws an error that we catch in order to capture its output.
const output = await $$$({ timeout: 1000 })`pnpm dev`.catch(result => {
  // should look something like
  //
  // VITE v5.2.6  ready in 415 ms
  //
  // ➜  Local:   http://localhost:5173/
  // ➜  Network: use --host to expose
  // ➜  press h + enter to show help
  return result.stdout
})

const success = output.includes("VITE") && output.includes("ready")

// cleanup
await $`git clean *.tgz -f`

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
