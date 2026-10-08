// Adapter-only check: identical records per tree, same in-memory backing/index.
import assert from "node:assert/strict"
import { performance } from "node:perf_hooks"
import { MemoryStore } from "./memory.mjs"

const trees = 100
const records = 48
const store = new MemoryStore()
const legacy = store.legacy()
const bytes = store.bytes()
for (let tree = 0; tree < trees; tree++) {
  for (let record = 0; record < records; record++) {
    const value = Uint8Array.of(tree, record)
    await legacy.save(
      ["subduction", "commits", String(tree), String(record)],
      value
    )
    await bytes.save(`subduction-v1/${tree}/commits/${record}`, value)
  }
}
store.resetStats()
const legacyStart = performance.now()
for (let tree = 0; tree < trees; tree++) {
  const entries = await legacy.loadRange([
    "subduction",
    "commits",
    String(tree),
  ])
  assert.equal(entries.length, records)
  assert.equal(entries[0].data[0], tree)
}
const legacyMs = performance.now() - legacyStart
const legacyStats = store.stats().loadRange
store.resetStats()
const byteStart = performance.now()
for (let tree = 0; tree < trees; tree++) {
  const entries = await bytes.loadPrefix(`subduction-v1/${tree}/commits/`)
  assert.equal(entries.length, records)
  assert.equal(entries[0][1][0], tree)
}
const byteMs = performance.now() - byteStart
const byteStats = store.stats().loadPrefix
assert.equal(legacyStats.values, trees * records)
assert.equal(byteStats.values, trees * records)
console.log(
  JSON.stringify(
    {
      trees,
      recordsPerTree: records,
      legacyMs,
      byteMs,
      legacyStats,
      byteStats,
    },
    null,
    2
  )
)
console.log("Adapter timings are diagnostic, not a performance gate.")
