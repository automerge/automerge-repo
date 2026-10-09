import { test } from "node:test"
import assert from "node:assert/strict"
import { MemoryStore } from "../memory.mjs"

test("byte-store batch writes copy data and survive adapter reopen", async () => {
  const store = new MemoryStore()
  const value = Uint8Array.of(1, 2)
  await store.bytes().saveBatch([["tree/commit/a", value]])
  value[0] = 9
  assert.deepEqual(
    await store.bytes().load("tree/commit/a"),
    Uint8Array.of(1, 2)
  )
  assert.equal(store.stats().saveBatch.calls, 1)
})

test("both adapters share copying, prefix, and reopen semantics", async () => {
  const store = new MemoryStore()
  const old = store.legacy()
  const bytes = store.bytes()
  const input = Uint8Array.of(1, 2)
  await old.save(["doc", "commits", "a"], input)
  await bytes.save("subduction-v1/tree/commits/a", input)
  input[0] = 9
  assert.deepEqual(await old.load(["doc", "commits", "a"]), Uint8Array.of(1, 2))
  assert.deepEqual(
    await bytes.load("subduction-v1/tree/commits/a"),
    Uint8Array.of(1, 2)
  )
  const range = await old.loadRange(["doc", "commits"])
  const prefix = await bytes.loadPrefix("subduction-v1/tree/commits/")
  range[0].data[0] = 7
  prefix[0][1][0] = 7
  assert.equal((await old.load(["doc", "commits", "a"]))[0], 1)
  assert.equal((await bytes.load("subduction-v1/tree/commits/a"))[0], 1)
  assert.deepEqual(await bytes.list("subduction-v1/tree/commits/"), [
    "subduction-v1/tree/commits/a",
  ])
  assert.equal(store.size().keys, 2)
  assert.deepEqual(store.keys().map(String).sort(), [
    "doc,commits,a",
    "subduction-v1/tree/commits/a",
  ])
  assert.equal((await store.legacy().loadRange(["doc"])).length, 1)
  assert.equal(
    (await store.bytes().loadPrefix("subduction-v1/tree/")).length,
    1
  )
  await old.removeRange(["doc"])
  await bytes.remove("subduction-v1/tree/commits/a")
  assert.equal(store.size().keys, 0)
})

test("Subduction JS prefixes isolate tree, not shared first segment", async () => {
  const store = new MemoryStore()
  const adapter = store.legacy()
  await adapter.saveBatch([
    [["subduction", "commits", "tree-a", "a"], Uint8Array.of(1)],
    [["subduction", "blobs", "tree-a", "b"], Uint8Array.of(2)],
    [["subduction", "commits", "tree-b", "c"], Uint8Array.of(3)],
  ])
  assert.deepEqual(
    (await adapter.loadRange(["subduction", "commits", "tree-a"])).map(
      entry => entry.data[0]
    ),
    [1]
  )
  assert.equal((await adapter.loadRange(["subduction"])).length, 3)
  assert.equal((await adapter.loadRange(["subduction", "commits"])).length, 2)
  assert.equal(store.stats().loadRange.values, 6)
})
