#!/usr/bin/env node
/**
 * Convert a Patchwork "diagnostics" zip into a sanitized real-world storage
 * fixture for the browser bench (`StorageBench.browser.test.ts`).
 *
 * The diagnostics bundle exports each IndexedDB store as
 *   idb/<db>.<store>.index.json   (records; binary values are {"$bin":[off,len]})
 *   idb/<db>.<store>.bin          (concatenated binary values)
 * plus the user's private signing key (`subduction-signer` store), full
 * localStorage, and logs. This script reads ONLY the `subduction/*` records of
 * the `automerge.documents` store and emits a base64 JSON fixture, so:
 *   - the private key, localStorage and unrelated docs never leave the dump;
 *   - fixtures stay under the gitignored `.ignore/` tree (the blobs are still
 *     the user's real document content — never commit them).
 *
 * Records are grouped by sedimentree id (key[2]); whole sedimentrees are kept
 * up to `--max-records` so documents load completely.
 *
 * Usage:
 *   node packages/automerge-repo/scripts/dump-to-fixture.mjs <dump.zip> \
 *     [--out <path>] [--max-records N] [--db automerge] [--store documents]
 */
import { createRequire } from "node:module"
import { closeSync, mkdirSync, openSync, readSync, writeFileSync, fstatSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "../../..")
const require = createRequire(import.meta.url)
// fflate is a hoisted transitive dep; fall back to its pnpm path if the bare
// specifier doesn't resolve from this script's location.
let inflateSync
try {
  ;({ inflateSync } = require("fflate"))
} catch {
  ;({ inflateSync } = require(
    resolve(repoRoot, "node_modules/.pnpm/fflate@0.8.2/node_modules/fflate")
  ))
}

// ── args ─────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
if (argv.length === 0 || argv[0].startsWith("--")) {
  console.error("usage: dump-to-fixture.mjs <dump.zip> [--out <path>] [--max-records N] [--db automerge] [--store documents]")
  process.exit(1)
}
const zipPath = resolve(argv[0])
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def
}
const db = opt("db", "automerge")
const store = opt("store", "documents")
const maxRecords = Number(opt("max-records", "0")) || Infinity
const defaultOut = resolve(
  repoRoot,
  ".ignore/bench-fixtures",
  `${basename(zipPath).replace(/\.zip$/i, "")}.subduction.fixture.json`
)
const outPath = resolve(opt("out", defaultOut))

// ── minimal zip reader (single entry, low memory) ────────────────────
const readEntries = fd => {
  const size = fstatSync(fd).size
  const tail = Buffer.alloc(Math.min(65557, size))
  readSync(fd, tail, 0, tail.length, size - tail.length)
  let eo = -1
  for (let i = tail.length - 22; i >= 0; i--)
    if (tail.readUInt32LE(i) === 0x06054b50) { eo = i; break }
  if (eo < 0) throw new Error("no End Of Central Directory record")
  const count = tail.readUInt16LE(eo + 10)
  const cdSize = tail.readUInt32LE(eo + 12)
  const cdOff = tail.readUInt32LE(eo + 16)
  const cd = Buffer.alloc(cdSize)
  readSync(fd, cd, 0, cdSize, cdOff)
  const entries = {}
  let off = 0
  for (let i = 0; i < count; i++) {
    const method = cd.readUInt16LE(off + 10)
    const comp = cd.readUInt32LE(off + 20)
    const nlen = cd.readUInt16LE(off + 28)
    const elen = cd.readUInt16LE(off + 30)
    const clen = cd.readUInt16LE(off + 32)
    const loff = cd.readUInt32LE(off + 42)
    const name = cd.toString("utf8", off + 46, off + 46 + nlen)
    entries[name] = { method, comp, loff }
    off += 46 + nlen + elen + clen
  }
  return entries
}

const extract = (fd, entry) => {
  const lh = Buffer.alloc(30)
  readSync(fd, lh, 0, 30, entry.loff)
  const nlen = lh.readUInt16LE(26)
  const elen = lh.readUInt16LE(28)
  const dataStart = entry.loff + 30 + nlen + elen
  const comp = Buffer.alloc(entry.comp)
  readSync(fd, comp, 0, entry.comp, dataStart)
  return entry.method === 0 ? comp : Buffer.from(inflateSync(comp))
}

// ── reconstruct subduction records ───────────────────────────────────
const findBin = v => {
  if (!v || typeof v !== "object") return null
  if (Array.isArray(v.$bin)) return v.$bin
  for (const k of Object.keys(v)) {
    const r = findBin(v[k])
    if (r) return r
  }
  return null
}

const fd = openSync(zipPath, "r")
try {
  const entries = readEntries(fd)
  const idxName = `idb/${db}.${store}.index.json`
  const binName = `idb/${db}.${store}.bin`
  if (!entries[idxName]) throw new Error(`entry not found: ${idxName}`)
  if (!entries[binName]) throw new Error(`entry not found: ${binName}`)

  console.log(`reading ${idxName} ...`)
  const index = JSON.parse(extract(fd, entries[idxName]).toString("utf8"))
  console.log(`reading ${binName} ...`)
  const bin = extract(fd, entries[binName])

  // Group subduction records by sedimentree id, then take whole groups.
  const bySid = new Map()
  for (const rec of index.records ?? []) {
    const key = rec.key
    if (!Array.isArray(key) || key[0] !== "subduction") continue
    const b = findBin(rec.value)
    if (!b) continue
    const [off, len] = b
    const data = bin.subarray(off, off + len)
    const sid = key[2] ?? "(no-sid)"
    if (!bySid.has(sid)) bySid.set(sid, [])
    bySid.get(sid).push({ key, data: Buffer.from(data).toString("base64") })
  }

  const records = []
  let truncated = false
  for (const group of bySid.values()) {
    if (records.length + group.length > maxRecords) { truncated = true; continue }
    for (const r of group) records.push(r)
  }

  const totalBytes = records.reduce(
    (n, r) => n + Buffer.from(r.data, "base64").length,
    0
  )
  const fixture = {
    source: basename(zipPath),
    generatedAt: new Date().toISOString(),
    db,
    store,
    sedimentrees: bySid.size,
    recordCount: records.length,
    totalBlobBytes: totalBytes,
    truncated,
    records,
  }

  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(fixture))
  console.log(
    `wrote ${outPath}\n  sedimentrees=${bySid.size} records=${records.length}` +
      `${truncated ? ` (truncated to <=${maxRecords})` : ""}` +
      ` bytes=${(totalBytes / 1024).toFixed(1)}KiB`
  )
} finally {
  closeSync(fd)
}
