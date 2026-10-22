import * as N from "@automerge/subduction"
import { describe, expect, it } from "vitest"
import { sedimentreeId } from "@automerge/automerge-repo/sedimentree"
import { StorageBridge, logicalId, nativeId } from "../src/storage.js"
import { DummySubductionStorageAdapter } from "../src/helpers/DummySubductionStorageAdapter.js"

const tree = nativeId(sedimentreeId("ab".repeat(16)))
const other = nativeId(sedimentreeId("cd".repeat(16)))
const head = (n: number) => n.toString(16).padStart(64, "0")
const bytes = (...values: number[]) => new Uint8Array(values)
const root = `subduction-v2/trees/${tree}`

class CountingStore extends DummySubductionStorageAdapter {
  readonly calls: string[] = []
  override async loadMany(keys: readonly string[]) {
    this.calls.push(`loadMany:${keys.join(",")}`)
    return super.loadMany(keys)
  }
  override async saveBatch(entries: readonly [string, Uint8Array][]) {
    this.calls.push(`saveBatch:${entries.map(([key]) => key).join(",")}`)
    return super.saveBatch(entries)
  }
  override async list(prefix: string) {
    this.calls.push(`list:${prefix}`)
    return super.list(prefix)
  }
  override async loadPrefix(prefix: string) {
    this.calls.push(`loadPrefix:${prefix}`)
    return super.loadPrefix(prefix)
  }
}

describe("StorageBridge", () => {
  it("maps 16-byte Repo IDs to zero-padded native IDs and back", () => {
    const id = sedimentreeId("ab".repeat(16))
    expect(nativeId(id)).toBe(`${"ab".repeat(16)}${"0".repeat(32)}`)
    expect(logicalId(nativeId(id))).toBe(id)
    const full = sedimentreeId("ab".repeat(32))
    expect(logicalId(nativeId(full))).toBe(full)
  })

  it("registers sedimentree IDs under an empty value", async () => {
    const store = new DummySubductionStorageAdapter()
    const bridge = new StorageBridge(store)
    await bridge.saveSedimentreeId(tree)
    await bridge.saveSedimentreeId(other)
    expect(await store.loadMany([`subduction-v2/ids/${tree}`])).toEqual([
      bytes(),
    ])
    expect((await bridge.loadAllSedimentreeIds()).sort()).toEqual(
      [tree, other].sort()
    )
    expect(await bridge.containsSedimentreeId(tree)).toBe(true)
    await bridge.deleteSedimentreeId(tree)
    expect(await bridge.containsSedimentreeId(tree)).toBe(false)
    expect(await bridge.loadAllSedimentreeIds()).toEqual([other])
  })

  describe.each([
    ["commits", "Commit", "Commits"],
    ["fragments", "Fragment", "Fragments"],
  ] as const)("%s", (kind, singular, plural) => {
    const save = (b: StorageBridge, h: string, s: Uint8Array, v: Uint8Array) =>
      b[`save${singular}`](tree, h, s, v)

    it("stores exactly the bytes it is sent, without reading first", async () => {
      const store = new CountingStore()
      const bridge = new StorageBridge(store)
      await save(bridge, head(1), bytes(1, 2), bytes(3))
      expect(store.calls).toEqual([
        `saveBatch:${root}/${kind}/signed/${head(1)},${root}/${kind}/blob/${head(1)}`,
      ])
      expect(await bridge[`load${singular}`](tree, head(1))).toEqual({
        signed: bytes(1, 2),
        blob: bytes(3),
      })
      expect(await bridge[`load${singular}`](tree, head(2))).toBeNull()
    })

    it("overwrites a record saved under the same head", async () => {
      const bridge = new StorageBridge(new DummySubductionStorageAdapter())
      await save(bridge, head(1), bytes(1), bytes(1))
      await save(bridge, head(1), bytes(2), bytes(2))
      expect(await bridge[`loadAll${plural}`](tree)).toEqual([
        { signed: bytes(2), blob: bytes(2) },
      ])
    })

    it("lists, loads and deletes per tree", async () => {
      const bridge = new StorageBridge(new DummySubductionStorageAdapter())
      await save(bridge, head(1), bytes(1), bytes(11))
      await save(bridge, head(2), bytes(2), bytes(12))
      await bridge[`save${singular}`](other, head(3), bytes(3), bytes(13))
      expect(await bridge[`list${singular}Ids`](tree)).toEqual([
        head(1),
        head(2),
      ])
      expect(await bridge[`loadAll${plural}`](tree)).toEqual([
        { signed: bytes(1), blob: bytes(11) },
        { signed: bytes(2), blob: bytes(12) },
      ])
      await bridge[`delete${singular}`](tree, head(1))
      expect(await bridge[`list${singular}Ids`](tree)).toEqual([head(2)])
      await bridge[`deleteAll${plural}`](tree)
      expect(await bridge[`loadAll${plural}`](tree)).toEqual([])
      expect(await bridge[`list${singular}Ids`](other)).toEqual([head(3)])
    })

    it.each(["signed", "blob"] as const)(
      "rejects a record missing its %s half",
      async part => {
        const store = new DummySubductionStorageAdapter()
        const bridge = new StorageBridge(store)
        await save(bridge, head(1), bytes(1), bytes(2))
        await store.removeBatch([`${root}/${kind}/${part}/${head(1)}`])
        await expect(bridge[`load${singular}`](tree, head(1))).rejects.toThrow(
          "Incomplete stored record"
        )
        await expect(bridge[`loadAll${plural}`](tree)).rejects.toThrow(
          "Incomplete stored record"
        )
      }
    )
  })

  it("saves a whole batch in one atomic write", async () => {
    const store = new CountingStore()
    const bridge = new StorageBridge(store)
    const count = await bridge.saveBatchAll(
      tree,
      [
        { commitId: head(1), signedCommit: bytes(1), blob: bytes(11) },
        { commitId: head(2), signedCommit: bytes(2), blob: bytes(12) },
      ],
      [{ fragmentHead: head(3), signedFragment: bytes(3), blob: bytes(13) }]
    )
    expect(count).toBe(3)
    expect(store.calls).toHaveLength(1)
    expect(store.calls[0]).toMatch(/^saveBatch:/)
    expect(await bridge.listCommitIds(tree)).toEqual([head(1), head(2)])
    expect(await bridge.loadFragment(tree, head(3))).toEqual({
      signed: bytes(3),
      blob: bytes(13),
    })
  })

  it("persists and reloads native history across nodes", async () => {
    const storage = new StorageBridge(new DummySubductionStorageAdapter())
    const signer = N.createMemorySigner(new Uint8Array(32).fill(42))
    const commits = [
      { head: head(1), parents: [], blob: bytes(1, 42) },
      { head: head(2), parents: [head(1)], blob: bytes(2, 42) },
    ]
    const writer = new N.Subduction({ signer, storage })
    try {
      await writer.storeBatch(tree, { commits })
    } finally {
      await writer.close()
      writer.free()
    }
    const reader = new N.Subduction({ signer, storage })
    try {
      expect(await reader.sedimentreeIds()).toEqual([tree])
      expect(await reader.getHeads(tree)).toEqual([head(2)])
      const blobs = await reader.getBlobs(tree)
      expect(blobs.map(b => [...b]).sort()).toEqual([
        [1, 42],
        [2, 42],
      ])
    } finally {
      await reader.close()
      reader.free()
    }
  })
})
