// Fixture generator runs outside the browser and initializes Automerge itself.
// eslint-disable-next-line no-restricted-imports
import * as A from "@automerge/automerge"
import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { join } from "node:path"

const count = Number(process.argv[2] ?? 1000)
if (!Number.isSafeInteger(count) || count < 1 || count > 1000)
  throw new Error("Count must be an integer between 1 and 1000")

const output = fileURLToPath(new URL("./public/fixtures/v1/", import.meta.url))
await mkdir(output, { recursive: true })
const files = []
for (let i = 0; i < count; i++) {
  const actor = (i + 1).toString(16).padStart(32, "0")
  let doc = A.change(A.init({ actor }), { time: 0 }, value => {
    value.title = `Document ${i}`
    value.items = Array.from({ length: 32 }, (_, j) => `item-${i}-${j}`)
    value.count = 0
  })
  for (let j = 1; j <= 50; j++) {
    doc = A.change(doc, { time: 0 }, value => {
      value.count = j
      value.items[j % 32] = `item-${i}-${j % 32}-revision-${j}`
    })
  }
  const bytes = A.save(doc)
  const name = `${String(i).padStart(4, "0")}.automerge`
  await writeFile(join(output, name), bytes)
  files.push({
    name,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  })
  if ((i + 1) % 100 === 0) console.log(`Generated ${i + 1}/${count}`)
}
const manifest = { version: 1, count, items: 32, changes: 51, files }
await writeFile(
  join(output, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n"
)
console.log(`Wrote ${count} documents to ${output}`)
