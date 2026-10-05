import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

const script = fileURLToPath(new URL("./version.mjs", import.meta.url))

function distTag(...args) {
  return spawnSync(process.execPath, [script, "dist-tag", ...args], {
    encoding: "utf8",
  })
}

for (const [tag, expected] of [
  ["v3.0.0", "latest"],
  ["v0.0.0", "latest"],
  ["v3.0.0-alpha.1", "next"],
  ["v3.0.0-beta.2", "next"],
  ["v3.0.0-rc.0", "next"],
  ["v3.0.0-experimental.1", "experimental"],
  ["v3.0.0-canary.12", "canary"],
  ["v3.0.0-feature-test.1", "feature-test"],
]) {
  await test(`${tag} selects ${expected}`, () => {
    const result = distTag(tag)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, `${expected}\n`)
    assert.equal(result.stderr, "")
  })
}

for (const tag of ["v3.0.0-latest.1", "v3.0.0-v1.1"]) {
  await test(`rejects reserved or version-like channel in ${tag}`, () => {
    const result = distTag(tag)
    assert.equal(result.status, 1)
    assert.equal(result.stdout, "")
    assert.match(result.stderr, /Invalid prerelease channel/)
  })
}

for (const tag of [
  "3.0.0",
  "v03.0.0",
  "v3.01.0",
  "v3.0.01",
  "v3x0x0",
  "v3.0.0-alpha",
  "v3.0.0-alpha.01",
  "v3.0.0-alphaX1",
  "v3.0.0-alpha.1.2",
  "v3.0.0-123.1",
  "v3.0.0-ALPHA.1",
  "v3.0.0\n",
]) {
  await test(`rejects malformed tag ${JSON.stringify(tag)}`, () => {
    const result = distTag(tag)
    assert.equal(result.status, 1)
    assert.equal(result.stdout, "")
    assert.match(result.stderr, /Expected vX.Y.Z or vX.Y.Z-<channel>.n/)
  })
}

for (const args of [[], ["v3.0.0", "extra"]]) {
  await test(`rejects ${args.length} arguments`, () => {
    const result = distTag(...args)
    assert.equal(result.status, 1)
    assert.equal(result.stdout, "")
    assert.match(result.stderr, /Usage:/)
  })
}
