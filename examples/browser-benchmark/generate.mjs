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
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex")
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
  files.push({ name, sha256: sha256(bytes), bytes: bytes.length })
  if ((i + 1) % 100 === 0) console.log(`Generated ${i + 1}/${count}`)
}
const manifest = { version: 1, count, items: 32, changes: 51, files }
await writeFile(
  join(output, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n"
)
console.log(`Wrote ${count} documents to ${output}`)

// Import fixtures live in their own manifest so the load manifest hash (and
// the prepared load store keyed by it) is unaffected. What matters for the
// import path is the number of sedimentree records a save/reload produces, not
// the change count: Automerge compacts long linear runs into fragments, so the
// record count is non-monotonic in changes (1,200 -> 588, 1,400 -> 96) and
// sensitive to the edited content. Each shape below is pinned by its measured
// record count and fails loudly if content or the Automerge version changes it.
function history({ changes }) {
  let doc = A.change(
    A.init({ actor: "1".padStart(32, "0") }),
    { time: 0 },
    value => {
      value.title = "large"
      value.items = Array.from({ length: 32 }, (_, j) => `item-${j}`)
      value.count = 0
    }
  )
  for (let j = 1; j <= changes; j++) {
    doc = A.change(doc, { time: 0 }, value => {
      value.count = j
      value.items[j % 32] = `r-${j}`
    })
  }
  return { doc, count: changes }
}
// Single-actor linear histories only: multi-actor merges did not regenerate to
// a stable record count across runs, which would break the manifest hash guard.
const importShapes = [
  // 3 chunks at 128 records.
  { name: "medium", changes: 1000, records: 388 },
  // 6 chunks at 128 records, 48 at 16.
  { name: "large", changes: 2200, records: 762 },
]
// Large histories simulate typing into one text field: text is the realistic
// stress case, since content and record sizes grow with history. A seeded PRNG
// keeps every regeneration byte-identical.
function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const words =
  "the quick brown fox jumps over a lazy dog while automerge keeps every edit in sync".split(
    " "
  )
function typing({ changes, seed }) {
  const next = random(seed)
  const pick = n => Math.floor(next() * n)
  let doc = A.change(
    A.init({ actor: "2".padStart(32, "0") }),
    { time: 0 },
    value => {
      value.text = ""
    }
  )
  let length = 0
  let cursor = 0
  for (let j = 1; j < changes; j++) {
    // Occasionally move the cursor elsewhere, as when editing earlier text.
    if (next() < 0.05) cursor = pick(length + 1)
    const remove = length > 0 && next() < 0.1
    let insert = ""
    let deleted = 0
    if (remove) {
      if (cursor === 0) cursor = length
      deleted = Math.min(cursor, 1 + pick(10))
    } else {
      const size = 1 + pick(20)
      while (insert.length < size)
        insert += next() < 0.05 ? "\n" : `${words[pick(words.length)]} `
      insert = insert.slice(0, size)
    }
    const at = cursor - deleted
    doc = A.change(doc, { time: 0 }, value => {
      A.splice(value, ["text"], at, deleted, insert)
    })
    length += insert.length - deleted
    cursor = at + insert.length
    if (j % 10000 === 0) console.log(`  text history: ${j}/${changes}`)
  }
  return doc
}
const textShapes = [
  { name: "text-10k", changes: 10000, seed: 10, records: 292 },
  { name: "text-30k", changes: 30000, seed: 30, records: 189 },
  { name: "text-100k", changes: 100000, seed: 100, records: 452 },
]

const imports = []
async function write(shape, doc, extra) {
  const bytes = A.save(doc)
  const loaded = A.load(bytes)
  const metadata = A.getFragmentMetadata(loaded)
  const loose = metadata.filter(meta => meta.level === 0).length
  if (metadata.length !== shape.records)
    throw new Error(
      `${shape.name}: expected ${shape.records} records after reload, got ${metadata.length}; update the shape`
    )
  const name = `import-${shape.name}.automerge`
  await writeFile(join(output, name), bytes)
  imports.push({
    name,
    sha256: sha256(bytes),
    bytes: bytes.length,
    changes: shape.changes,
    records: metadata.length,
    loose,
    fragments: metadata.length - loose,
    ...extra,
  })
  console.log(
    `Import fixture ${shape.name}: ${metadata.length} records (${loose} loose, ${metadata.length - loose} fragments), ${bytes.length} bytes`
  )
}
for (const shape of importShapes) {
  const { doc, count } = history(shape)
  await write(shape, doc, { count })
}
for (const shape of textShapes) {
  const doc = typing(shape)
  if (A.getAllChanges(doc).length !== shape.changes)
    throw new Error(`${shape.name}: expected ${shape.changes} changes`)
  const text = doc.text
  await write(shape, doc, {
    textLength: text.length,
    textSha256: sha256(new TextEncoder().encode(text)),
  })
}
await writeFile(
  join(output, "imports.json"),
  JSON.stringify({ version: 1, files: imports }, null, 2) + "\n"
)
