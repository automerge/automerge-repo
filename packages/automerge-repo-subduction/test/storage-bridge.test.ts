// Fullfat initializes the runtime shared by the bridge's slim imports.
import * as N from "@automerge/subduction"
import { beforeAll, describe, expect, it, vi } from "vitest"
import {
  commitId,
  recordBytes,
  sedimentreeId,
  type SedimentreeId,
  type FragmentRecord,
  type LooseCommitRecord,
  type SedimentreeRecord,
} from "@automerge/automerge-repo/sedimentree"
import {
  StorageBridge,
  logicalId,
  nativeId,
  unsigned,
  unsignedFragment,
} from "../src/storage.js"
import type { ByteStore } from "../src/ByteStore.js"
import { deferred, storedRecords } from "./storage.js"
import { signedBytes } from "./frame.js"

const tree = sedimentreeId("ab".repeat(16))
const other = sedimentreeId("cd".repeat(16))
const cid = (n: number) => commitId(n.toString(16).padStart(64, "0"))
const commit = (n: number): LooseCommitRecord => ({
  kind: "commit",
  id: cid(n),
  parents: [],
  blob: new Uint8Array([n, 42]),
})
const fragment: FragmentRecord = {
  kind: "fragment",
  head: cid(1),
  boundary: [],
  checkpoints: [],
  blob: new Uint8Array([8, 42]),
}
const conflict = { ...commit(1), blob: new Uint8Array([9, 42]) }

class MemoryStore implements ByteStore {
  readonly values = new Map<string, Uint8Array>()
  readonly calls: string[] = []
  /** Every key committed by save or saveBatch, in order. */
  readonly written: string[] = []
  before?: (op: string, key: string) => Promise<void>
  /** Runs after a write commits; a throw makes the outcome ambiguous. */
  afterSave?: (keys: string[]) => void
  active = 0
  maxActive = 0
  private async run<T>(op: string, key: string, action: () => T): Promise<T> {
    this.calls.push(`${op}:${key}`)
    this.maxActive = Math.max(this.maxActive, ++this.active)
    try {
      await this.before?.(op, key)
      return action()
    } finally {
      this.active--
    }
  }
  load(key: string) {
    return this.run("load", key, () => this.values.get(key)?.slice())
  }
  loadMany(keys: readonly string[]) {
    return this.run("loadMany", keys.join(","), () =>
      keys.map(key => this.values.get(key)?.slice())
    )
  }
  save(key: string, bytes: Uint8Array) {
    return this.run("save", key, () => this.commit([[key, bytes]]))
  }
  saveBatch(entries: readonly [string, Uint8Array][]) {
    const keys = entries.map(([key]) => key)
    return this.run("saveBatch", keys.join(","), () => this.commit(entries))
  }
  private commit(entries: readonly [string, Uint8Array][]) {
    for (const [key, bytes] of entries) this.values.set(key, bytes.slice())
    this.written.push(...entries.map(([key]) => key))
    this.afterSave?.(entries.map(([key]) => key))
  }
  remove(key: string) {
    return this.run("remove", key, () => {
      this.values.delete(key)
    })
  }
  removeBatch(keys: readonly string[]) {
    return this.run("removeBatch", keys.join(","), () => {
      for (const key of keys) this.values.delete(key)
    })
  }
  removeRange(prefix: string) {
    return this.run("removeRange", prefix, () => {
      for (const key of this.values.keys())
        if (key.startsWith(prefix)) this.values.delete(key)
    })
  }
  loadPrefix(prefix: string) {
    return this.run("loadPrefix", prefix, () =>
      [...this.values.keys()]
        .filter(k => k.startsWith(prefix))
        .sort()
        .map((k): [string, Uint8Array] => [k, this.values.get(k)!.slice()])
    )
  }
  list(prefix: string) {
    return this.run("list", prefix, () =>
      [...this.values.keys()].filter(k => k.startsWith(prefix))
    )
  }
}

const signed = new Map<SedimentreeRecord, Uint8Array>()
const first = commit(1),
  second = commit(2),
  third = commit(3)
beforeAll(async () => {
  const signer = N.MemorySigner.fromBytes(new Uint8Array(32).fill(42))
  try {
    for (const record of [first, second, third, conflict, fragment]) {
      const storage = new MemoryStore()
      const bridge = new StorageBridge(storage)
      const engine = new N.Subduction({ signer, storage: bridge })
      const id = nativeId(tree)
      try {
        await engine.storeBuiltBatch(
          id,
          record.kind === "commit"
            ? [new N.CommitInput(unsigned(id, record), record.blob)]
            : [],
          record.kind === "fragment"
            ? [new N.FragmentInput(unsignedFragment(id, record), record.blob)]
            : []
        )
        const value = [...storage.values.entries()].find(([k]) =>
          k.includes("/meta/")
        )![1]
        signed.set(record, signedBytes(value))
      } finally {
        await engine.disconnectAll()
        engine.free()
        id.free()
      }
    }
  } finally {
    signer.free()
  }
})

function withId<T>(run: (id: N.SedimentreeId) => T, sid = tree): T {
  const id = nativeId(sid)
  try {
    return run(id)
  } finally {
    id.free()
  }
}
function save(
  bridge: StorageBridge,
  record: SedimentreeRecord,
  sid = tree
): Promise<void> {
  const key = N.CommitId.fromHexString(
    record.kind === "commit" ? record.id : record.head
  )
  const blob = record.blob.slice()
  const value =
    record.kind === "commit"
      ? N.SignedLooseCommit.tryDecode(signed.get(record)!)
      : N.SignedFragment.tryDecode(signed.get(record)!)
  try {
    return withId(
      id =>
        record.kind === "commit"
          ? bridge.saveCommit(id, key, value as N.SignedLooseCommit, blob)
          : bridge.saveFragment(id, key, value as N.SignedFragment, blob),
      sid
    )
  } finally {
    // Intentionally release/reuse every input BEFORE the queued work starts.
    key.free()
    value.free()
    blob.fill(0)
  }
}
function batch(
  bridge: StorageBridge,
  records: SedimentreeRecord[],
  sid = tree
) {
  const inputs = records
    .filter((r): r is LooseCommitRecord => r.kind === "commit")
    .map(record => ({
      commitId: N.CommitId.fromHexString(record.id),
      signedCommit: N.SignedLooseCommit.tryDecode(signed.get(record)!),
      blob: record.blob.slice(),
    }))
  const fragments = records
    .filter((r): r is FragmentRecord => r.kind === "fragment")
    .map(record => ({
      fragmentHead: N.CommitId.fromHexString(record.head),
      signedFragment: N.SignedFragment.tryDecode(signed.get(record)!),
      blob: record.blob.slice(),
    }))
  try {
    return withId(id => bridge.saveBatchAll(id, inputs, fragments), sid)
  } finally {
    inputs.forEach(input => {
      input.commitId.free()
      input.signedCommit.free()
      input.blob.fill(0)
    })
    fragments.forEach(input => {
      input.fragmentHead.free()
      input.signedFragment.free()
      input.blob.fill(0)
    })
    inputs.length = 0
    fragments.length = 0
  }
}
function pause(
  storage: MemoryStore,
  predicate: (op: string, key: string) => boolean
) {
  const entered = deferred(),
    release = deferred()
  storage.before = async (op, key) => {
    if (predicate(op, key)) {
      entered.resolve()
      await release.promise
    }
  }
  return { entered: entered.promise, release: release.resolve }
}

function dispose(value: unknown): void {
  if (Array.isArray(value)) value.forEach(dispose)
  else if (value && typeof value === "object" && "free" in value)
    (value as { free(): void }).free()
}

describe("StorageBridge native transactions", () => {
  it("ignores earlier storage namespaces without erasing them", async () => {
    const storage = new MemoryStore()
    const key = `subduction-v1/${tree.padEnd(64, "0")}/id`
    storage.values.set(key, new Uint8Array([1]))
    const bridge = new StorageBridge(storage)
    expect(await storedRecords(bridge, tree)).toEqual([])
    await save(bridge, first)
    expect(await storedRecords(bridge, tree)).toEqual([first])
    expect(storage.values.get(key)).toEqual(new Uint8Array([1]))
  })

  it("rejects a signed record under a different storage key", async () => {
    const storage = new MemoryStore()
    const bridge = new StorageBridge(storage)
    const wrong = N.CommitId.fromHexString(second.id)
    const value = N.SignedLooseCommit.tryDecode(signed.get(first)!)
    try {
      await expect(
        withId(id => bridge.saveCommit(id, wrong, value, first.blob))
      ).rejects.toThrow(/key/)
      expect(storage.values.size).toBe(0)
    } finally {
      wrong.free()
      value.free()
    }
  })

  it.each([
    ["commit", "single save"],
    ["commit", "batch"],
    ["fragment", "single save"],
    ["fragment", "batch"],
  ] as const)(
    "rejects a %s signed for another tree (%s) without writing it",
    async (kind, path) => {
      const storage = new MemoryStore()
      const bridge = new StorageBridge(storage)
      const record = kind === "commit" ? first : fragment
      // Signed for `tree`, offered under `other`, as a remote peer could.
      const write =
        path === "batch"
          ? batch(bridge, [record], other)
          : save(bridge, record, other)
      await expect(write).rejects.toThrow(/different tree/)
      expect(storage.values.size).toBe(0)
    }
  )

  it("accepts an identical record another bridge already saved without rewriting bytes", async () => {
    const storage = new MemoryStore()
    const a = new StorageBridge(storage)
    const b = new StorageBridge(storage)
    await save(a, first)
    await save(b, first)
    expect(storage.written).toHaveLength(2)
  })

  it("rejects a stored same-key conflict; concurrent exact duplicates converge", async () => {
    const storage = new MemoryStore()
    const bridge = new StorageBridge(storage)
    const outcomes = await Promise.allSettled([
      save(bridge, first),
      save(bridge, first),
      save(bridge, fragment),
      save(bridge, fragment),
    ])
    expect(outcomes.map(r => r.status)).toEqual([
      "fulfilled",
      "fulfilled",
      "fulfilled",
      "fulfilled",
    ])
    await expect(save(bridge, conflict)).rejects.toMatchObject({
      code: "conflict",
    })
    expect(await storedRecords(bridge, tree)).toEqual([first, fragment])
  })

  it("owns decoded blobs after the stored bytes change", async () => {
    const storage = new MemoryStore()
    const bridge = new StorageBridge(storage)
    await save(bridge, first)
    const [record] = await storedRecords(bridge, tree)
    const blob = [...storage.values.entries()].find(([key]) =>
      key.includes("/blob/")
    )![1]
    blob[blob.length - 1] ^= 0xff
    expect(record.blob).toEqual(first.blob)
  })

  it("passes bulk records to Subduction without materializing Repo records", async () => {
    const storage = new MemoryStore()
    const bridge = new StorageBridge(storage)
    await save(bridge, first)
    await save(bridge, fragment)
    const commitPayload = vi
      .spyOn(N.SignedLooseCommit.prototype, "payload", "get")
      .mockImplementation(() => {
        throw new Error("materialized commit")
      })
    const fragmentPayload = vi
      .spyOn(N.SignedFragment.prototype, "payload", "get")
      .mockImplementation(() => {
        throw new Error("materialized fragment")
      })
    try {
      const commits = await withId(id => bridge.loadAllCommits(id))
      const fragments = await withId(id => bridge.loadAllFragments(id))
      expect(commits.map(c => c.blob)).toEqual([first.blob])
      expect(fragments.map(f => f.blob)).toEqual([fragment.blob])
      commits.forEach(c => c.free())
      fragments.forEach(f => f.free())
      expect(commitPayload).not.toHaveBeenCalled()
      expect(fragmentPayload).not.toHaveBeenCalled()
    } finally {
      commitPayload.mockRestore()
      fragmentPayload.mockRestore()
    }
  })

  it("passes an empty stored blob through without bridge validation", async () => {
    const storage = new MemoryStore()
    const bridge = new StorageBridge(storage)
    await save(bridge, first)
    const blobKey = [...storage.values.keys()].find(k =>
      k.includes(`/commits/blob/${first.id}`)
    )!
    storage.values.set(blobKey, new Uint8Array())
    const commits = await withId(id => bridge.loadAllCommits(id))
    try {
      expect(commits).toHaveLength(1)
      expect(commits[0].blob).toEqual(new Uint8Array())
    } finally {
      commits.forEach(c => c.free())
    }
  })

  it("frees already built native wrappers when a later bulk frame is malformed", async () => {
    const storage = new MemoryStore()
    const bridge = new StorageBridge(storage)
    await save(bridge, first)
    await save(bridge, second)
    const key = [...storage.values.keys()].find(k =>
      k.includes(`/commits/meta/${second.id}`)
    )!
    storage.values.set(key, new Uint8Array([1]))
    const free = vi.spyOn(N.CommitWithBlob.prototype, "free")
    try {
      await expect(withId(id => bridge.loadAllCommits(id))).rejects.toThrow()
      expect(free).toHaveBeenCalledOnce()
    } finally {
      free.mockRestore()
    }
  })

  it("frees already built fragments when a later bulk frame is malformed", async () => {
    const storage = new MemoryStore()
    const bridge = new StorageBridge(storage)
    await save(bridge, fragment)
    const metaKey = [...storage.values.keys()].find(k =>
      k.includes("/fragments/meta/")
    )!
    const otherKey = metaKey.replace(fragment.head, cid(2))
    storage.values.set(otherKey, new Uint8Array([1]))
    storage.values.set(otherKey.replace("/meta/", "/blob/"), fragment.blob)
    const free = vi.spyOn(N.FragmentWithBlob.prototype, "free")
    try {
      await expect(withId(id => bridge.loadAllFragments(id))).rejects.toThrow()
      expect(free).toHaveBeenCalledOnce()
    } finally {
      free.mockRestore()
    }
  })

  it.each(["meta", "blob"] as const)(
    "rejects incomplete %s records in both point and bulk reads",
    async part => {
      const storage = new MemoryStore()
      const bridge = new StorageBridge(storage)
      await save(bridge, first)
      const key = [...storage.values.keys()].find(k =>
        k.includes(part === "meta" ? "/meta/" : "/blob/")
      )!
      storage.values.delete(key)
      const id = N.CommitId.fromHexString(first.id)
      try {
        await expect(
          withId(treeId => bridge.loadCommit(treeId, id))
        ).rejects.toThrow("Incomplete stored record")
        await expect(storedRecords(bridge, tree)).rejects.toThrow(
          "Incomplete stored record"
        )
        await expect(
          withId(treeId => bridge.loadAllCommits(treeId))
        ).rejects.toThrow("Incomplete stored record")
      } finally {
        id.free()
      }
    }
  )

  it("saves without reading the rest of the tree's history", async () => {
    const storage = new MemoryStore()
    const bridge = new StorageBridge(storage)
    await save(bridge, first)
    await save(bridge, fragment)
    storage.calls.length = 0
    await save(bridge, second)
    // One same-key lookup and one write; no list or whole-history loads.
    const path = `subduction-v2/trees/${tree.padEnd(64, "0")}/commits/`
    const meta = `${path}meta/${cid(2)}`
    const blob = `${path}blob/${cid(2)}`
    expect(storage.calls).toEqual([
      `loadMany:${meta},${blob}`,
      `saveBatch:${meta},${blob}`,
    ])
  })

  it("lists commit IDs and fragment heads from metadata keys only", async () => {
    const storage = new MemoryStore()
    const bridge = new StorageBridge(storage)
    await save(bridge, first)
    await save(bridge, second)
    await save(bridge, fragment)
    storage.calls.length = 0
    const commits = await withId(id => bridge.listCommitIds(id))
    const fragments = await withId(id => bridge.listFragmentIds(id))
    try {
      expect(commits.map(id => id.toHexString())).toEqual([cid(1), cid(2)])
      expect(fragments.map(id => id.toHexString())).toEqual([cid(1)])
    } finally {
      commits.forEach(id => id.free())
      fragments.forEach(id => id.free())
    }
    expect(storage.calls).toEqual([
      `list:subduction-v2/trees/${tree.padEnd(64, "0")}/commits/meta/`,
      `list:subduction-v2/trees/${tree.padEnd(64, "0")}/fragments/meta/`,
    ])
  })

  it("does not sequence same-document reads behind an in-flight write", async () => {
    const storage = new MemoryStore()
    const bridge = new StorageBridge(storage)
    await Promise.all([save(bridge, first), save(bridge, fragment)])
    const gate = pause(
      storage,
      (op, key) => op === "saveBatch" && key.includes(cid(3))
    )
    const writing = save(bridge, third)
    await gate.entered
    const key = N.CommitId.fromHexString(cid(1))
    const operations = withId(id => [
      bridge.loadCommit(id, key),
      bridge.listCommitIds(id),
      bridge.loadAllCommits(id),
      bridge.loadFragment(id, key),
      bridge.listFragmentIds(id),
      bridge.loadAllFragments(id),
    ])
    key.free()
    // Reads complete while the write is still held.
    const values = await Promise.all(operations)
    for (const index of [1, 2, 4, 5]) expect(values[index]).toHaveLength(1)
    expect(values[0]).toBeInstanceOf(N.CommitWithBlob)
    expect(values[3]).toBeInstanceOf(N.FragmentWithBlob)
    values.forEach(dispose)
    expect(storage.maxActive).toBeGreaterThan(1)
    gate.release()
    await writing
  })

  it("overlaps reads of different documents", async () => {
    const storage = new MemoryStore()
    const bridge = new StorageBridge(storage)
    const gate = pause(
      storage,
      (op, key) =>
        op === "loadPrefix" &&
        key.includes(`trees/${tree.padEnd(64, "0")}/commits/`)
    )
    const first = withId(id => bridge.loadAllCommits(id))
    await gate.entered
    const second = await withId(id => bridge.loadAllCommits(id), other)
    expect(second).toEqual([])
    expect(storage.maxActive).toBe(2)
    gate.release()
    expect(await first).toEqual([])
  })

  it("writes records atomically without registering the tree itself", async () => {
    const storage = new MemoryStore()
    const bridge = new StorageBridge(storage)
    const error = new Error("disk failed")
    storage.before = async op => {
      if (op === "saveBatch") throw error
    }
    await expect(batch(bridge, [first, second, fragment])).rejects.toBe(error)
    expect(storage.values.size).toBe(0)
    expect(await withId(id => bridge.containsSedimentreeId(id))).toBe(false)
    storage.before = undefined
    await batch(bridge, [first, second, fragment])
    expect(storage.written).toHaveLength(6)
    expect(await withId(id => bridge.containsSedimentreeId(id))).toBe(false)
    expect(await storedRecords(bridge, tree)).toEqual([first, second, fragment])
  })

  it("lists registered IDs without reading records, including empty trees", async () => {
    const storage = new MemoryStore()
    const bridge = new StorageBridge(storage)
    await withId(id => bridge.saveSedimentreeId(id))
    const key = `subduction-v2/ids/${tree.padEnd(64, "0")}`
    expect(storage.values.get(key)).toEqual(withId(id => id.toBytes()))
    storage.calls.length = 0
    expect(await withId(id => bridge.containsSedimentreeId(id))).toBe(true)
    expect(storage.calls).toEqual([`load:${key}`])
    storage.calls.length = 0
    const ids = await bridge.loadAllSedimentreeIds()
    try {
      expect(ids.map(logicalId)).toEqual([tree])
    } finally {
      ids.forEach(id => id.free())
    }
    expect(storage.calls).toEqual(["loadPrefix:subduction-v2/ids/"])
    await withId(id => bridge.deleteSedimentreeId(id))
    expect(await withId(id => bridge.containsSedimentreeId(id))).toBe(false)
  })

  it("rejects an ambiguous batch save to native; an exact retry does not rewrite", async () => {
    const storage = new MemoryStore()
    const bridge = new StorageBridge(storage)
    const error = new Error("saved, then rejected")
    storage.afterSave = () => {
      throw error
    }
    await expect(batch(bridge, [first, second, third])).rejects.toBe(error)
    expect(await storedRecords(bridge, tree)).toEqual([first, second, third])
    storage.afterSave = undefined
    const written = storage.written.length
    await batch(bridge, [first, second, third])
    expect(
      storage.written.slice(written).filter(key => key.includes("/commits/"))
    ).toEqual([])
  })

  it("rejects synchronous preparation errors without touching storage", async () => {
    const storage = new MemoryStore()
    const bridge = new StorageBridge(storage)
    const wrong = N.CommitId.fromHexString(second.id)
    const value = N.SignedLooseCommit.tryDecode(signed.get(first)!)
    let operation: Promise<void>
    try {
      operation = withId(id => bridge.saveCommit(id, wrong, value, first.blob))
    } finally {
      wrong.free()
      value.free()
    }
    await expect(operation).rejects.toThrow(/key/)
    expect(storage.calls).toEqual([])
  })
})
