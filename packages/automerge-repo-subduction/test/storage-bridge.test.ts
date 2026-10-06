// Fullfat initializes the runtime shared by the bridge's slim imports.
import * as N from "@automerge/subduction"
import { beforeAll, describe, expect, it, vi } from "vitest"
import {
  commitId,
  recordBytes,
  sedimentreeId,
  type FragmentRecord,
  type LooseCommitRecord,
  type SedimentreeRecord,
} from "@automerge/automerge-repo/sedimentree"
import {
  StorageBridge,
  nativeId,
  unsigned,
  unsignedFragment,
  type LocalByteStore,
} from "../src/storage.js"
import { deferred } from "./storage.js"

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
const limits = {
  maxRecordBytes: 4096,
  maxSnapshotBytes: 16384,
  maxRecords: 100,
}

class MemoryStore implements LocalByteStore {
  readonly values = new Map<string, Uint8Array>()
  readonly calls: string[] = []
  before?: (op: string, key: string) => Promise<void>
  afterSave?: (key: string) => void
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
  save(key: string, bytes: Uint8Array) {
    return this.run("save", key, () => {
      this.values.set(key, bytes.slice())
      this.afterSave?.(key)
    })
  }
  remove(key: string) {
    return this.run("remove", key, () => {
      this.values.delete(key)
    })
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
      const bridge = new StorageBridge(storage, limits, () => {})
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
        const value = [...storage.values.entries()].find(
          ([k]) => !k.endsWith("/id")
        )![1]
        const frame = JSON.parse(new TextDecoder().decode(value))
        signed.set(record, Uint8Array.from(Buffer.from(frame.signed, "hex")))
      } finally {
        await engine.disconnectAll()
        await bridge.drain()
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
function save(bridge: StorageBridge, record: SedimentreeRecord): Promise<void> {
  const key = N.CommitId.fromHexString(
    record.kind === "commit" ? record.id : record.head
  )
  const blob = record.blob.slice()
  const value =
    record.kind === "commit"
      ? N.SignedLooseCommit.tryDecode(signed.get(record)!)
      : N.SignedFragment.tryDecode(signed.get(record)!)
  try {
    return withId(id =>
      record.kind === "commit"
        ? bridge.saveCommit(id, key, value as N.SignedLooseCommit, blob)
        : bridge.saveFragment(id, key, value as N.SignedFragment, blob)
    )
  } finally {
    // Intentionally release/reuse every input BEFORE the queued work starts.
    key.free()
    value.free()
    blob.fill(0)
  }
}
function batch(bridge: StorageBridge, records: SedimentreeRecord[]) {
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
    return withId(id => bridge.saveBatchAll(id, inputs, fragments))
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

describe("StorageBridge native transaction serialization", () => {
  it("notifies when another bridge already saved an identical record without rewriting bytes", async () => {
    const storage = new MemoryStore()
    const firstSaved = vi.fn(),
      secondSaved = vi.fn()
    const a = new StorageBridge(storage, limits, firstSaved)
    const b = new StorageBridge(storage, limits, secondSaved)
    await save(a, first)
    await save(b, first)
    expect(firstSaved.mock.calls).toEqual([[tree, first]])
    expect(secondSaved.mock.calls).toEqual([[tree, first]])
    expect(storage.calls.filter(call => call.startsWith("save:"))).toHaveLength(
      1
    )
  })

  it("serializes same-head conflicts and exact retries, but allows both kinds", async () => {
    const storage = new MemoryStore(),
      saved = vi.fn(),
      failed = vi.fn()
    const bridge = new StorageBridge(storage, limits, saved, failed)
    const outcomes = await Promise.allSettled([
      save(bridge, first),
      save(bridge, first),
      save(bridge, conflict),
      save(bridge, fragment),
      save(bridge, fragment),
    ])
    expect(outcomes.map(r => r.status)).toEqual([
      "fulfilled",
      "fulfilled",
      "rejected",
      "fulfilled",
      "fulfilled",
    ])
    expect(outcomes[2]).toMatchObject({ reason: { code: "conflict" } })
    expect(saved.mock.calls).toEqual([
      [tree, first],
      [tree, first],
      [tree, fragment],
      [tree, fragment],
    ])
    expect(failed).toHaveBeenCalledOnce()
    expect(await withId(id => bridge.records(id))).toEqual([first, fragment])
    expect(storage.calls.filter(c => c.startsWith("save:"))).toHaveLength(2)
    expect(storage.maxActive).toBe(1)
  })

  it.each(["count", "bytes"])(
    "enforces aggregate %s limits on reads, not on individual saves",
    async kind => {
      const storage = new MemoryStore()
      const bridge = new StorageBridge(
        storage,
        {
          ...limits,
          ...(kind === "count"
            ? { maxRecords: 1 }
            : { maxSnapshotBytes: recordBytes(first) }),
        },
        () => {}
      )
      const results = await Promise.allSettled([
        save(bridge, first),
        save(bridge, second),
      ])
      expect(results.map(r => r.status)).toEqual(["fulfilled", "fulfilled"])
      await expect(withId(id => bridge.records(id))).rejects.toThrow(
        /limit exceeded/
      )
    }
  )

  it("saves without reading the rest of the tree's history", async () => {
    const storage = new MemoryStore()
    const bridge = new StorageBridge(storage, limits, () => {})
    await save(bridge, first)
    await save(bridge, fragment)
    storage.calls.length = 0
    await save(bridge, second)
    // One same-key lookup and one write; no list or whole-history loads.
    const path = `subduction-v1/${tree.padEnd(64, "0")}/commits/${cid(2)}`
    expect(storage.calls).toEqual([`load:${path}`, `save:${path}`])
  })

  it("keeps batches, reads, and cleanup in acceptance order with freed inputs", async () => {
    const storage = new MemoryStore(),
      saved = vi.fn()
    const bridge = new StorageBridge(storage, limits, saved)
    const gate = pause(
      storage,
      (op, key) => op === "save" && key.endsWith(cid(1))
    )
    const writing = batch(bridge, [first, second, fragment])
    const snapshot = withId(id => bridge.records(id))
    const later = save(bridge, third)
    const cleanup = withId(id => bridge.cleanup(id))
    const empty = withId(id => bridge.records(id))
    await gate.entered
    expect(saved).not.toHaveBeenCalled()
    gate.release()
    await expect(writing).resolves.toBe(3)
    await expect(snapshot).resolves.toEqual([first, second, fragment])
    await Promise.all([later, cleanup])
    await expect(empty).resolves.toEqual([])
    expect(saved.mock.calls).toEqual([
      [tree, first],
      [tree, second],
      [tree, fragment],
      [tree, third],
    ])
    expect(storage.maxActive).toBe(1)
    expect(storage.values.size).toBe(0)
  })

  it("queues every native read/delete transaction behind accepted writes", async () => {
    const storage = new MemoryStore()
    const bridge = new StorageBridge(storage, limits, () => {})
    await Promise.all([save(bridge, first), save(bridge, fragment)])
    const gate = pause(
      storage,
      (op, key) => op === "save" && key.endsWith("/id")
    )
    const marker = withId(id => bridge.saveSedimentreeId(id))
    await gate.entered
    const calls = storage.calls.length
    const key = N.CommitId.fromHexString(cid(1))
    const operations = withId(id => [
      bridge.records(id),
      bridge.loadAllSedimentreeIds(),
      bridge.containsSedimentreeId(id),
      bridge.loadCommit(id, key),
      bridge.listCommitIds(id),
      bridge.loadAllCommits(id),
      bridge.loadFragment(id, key),
      bridge.listFragmentIds(id),
      bridge.loadAllFragments(id),
      bridge.deleteCommit(id, key),
      bridge.deleteFragment(id, key),
      bridge.deleteAllCommits(id),
      bridge.deleteAllFragments(id),
      bridge.deleteSedimentreeId(id),
      bridge.cleanup(id),
    ])
    key.free()
    await Promise.resolve()
    expect(storage.calls).toHaveLength(calls)
    gate.release()
    await marker
    const values = await Promise.all(operations)
    expect(values[0]).toEqual([first, fragment])
    expect(values[2]).toBe(true)
    for (const index of [1, 4, 5, 7, 8]) expect(values[index]).toHaveLength(1)
    expect(values[3]).toBeInstanceOf(N.CommitWithBlob)
    expect(values[6]).toBeInstanceOf(N.FragmentWithBlob)
    values.forEach(dispose)
    expect(storage.values.size).toBe(0)
    expect(storage.maxActive).toBe(1)
  })

  it("preserves durable batch prefixes and reports ambiguous saves without notifying success", async () => {
    const storage = new MemoryStore(),
      saved = vi.fn(),
      failed = vi.fn()
    const bridge = new StorageBridge(storage, limits, saved, failed)
    const error = new Error("saved, then rejected")
    storage.afterSave = key => {
      if (key.endsWith(cid(2))) throw error
    }
    await expect(batch(bridge, [first, second, third])).rejects.toBe(error)
    expect(saved.mock.calls).toEqual([[tree, first]])
    expect(failed.mock.calls).toEqual([[tree, error]])
    expect(await withId(id => bridge.records(id))).toEqual([first, second])
    await expect(bridge.flush()).rejects.toMatchObject({ errors: [error] })
    await expect(bridge.flush()).resolves.toBeUndefined()
    storage.afterSave = undefined
    await batch(bridge, [first, second, third])
    // An exact retry doesn't save again, but recovers missed notifications.
    expect(saved.mock.calls).toEqual([
      [tree, first],
      [tree, first],
      [tree, second],
      [tree, third],
    ])
    expect(
      storage.calls.filter(
        call => call.startsWith("save:") && call.includes("/commits/")
      )
    ).toHaveLength(3)
  })

  it("reports synchronous preparation errors through failed and flush", async () => {
    const storage = new MemoryStore(),
      failed = vi.fn()
    const bridge = new StorageBridge(
      storage,
      { ...limits, maxRecordBytes: 1 },
      () => {},
      failed
    )
    const operation = save(bridge, first)
    const flushed = bridge.flush()
    await expect(operation).rejects.toThrow("Record limit exceeded")
    await expect(flushed).rejects.toMatchObject({ errors: [expect.any(Error)] })
    expect(failed.mock.calls[0][0]).toBe(tree)
    expect(storage.calls).toEqual([])
    await bridge.flush()
    await bridge.drain()
  })

  it("flush captures relevant pending/failed mutations, waits ALL and clears reported failures", async () => {
    const storage = new MemoryStore(),
      failed = vi.fn()
    const bridge = new StorageBridge(storage, limits, () => {}, failed)
    const errorA = new Error("A"),
      errorB = new Error("B")
    const gate = pause(
      storage,
      (op, key) => op === "remove" && key.includes(other)
    )
    storage.afterSave = () => {
      throw errorA
    }
    const a = withId(id => bridge.saveSedimentreeId(id)).catch(e => e)
    const b = withId(id => bridge.deleteSedimentreeId(id), other).catch(e => e)
    const originalRemove = storage.remove.bind(storage)
    storage.remove = async key => {
      await originalRemove(key)
      throw errorB
    }
    const onlyA = bridge.flush([tree])
    const all = bridge.flush()
    let allSettled = false
    const allResult = all
      .catch(e => e)
      .finally(() => {
        allSettled = true
      })
    await gate.entered
    await expect(onlyA).rejects.toMatchObject({ errors: [errorA] })
    expect(allSettled).toBe(false)
    // A new failed attempt is not cleared by either already captured barrier.
    const later = withId(id => bridge.saveSedimentreeId(id)).catch(e => e)
    gate.release()
    expect(await allResult).toMatchObject({ errors: [errorA, errorB] })
    await Promise.all([a, b, later])
    await expect(bridge.flush([other])).resolves.toBeUndefined()
    await expect(bridge.flush([tree])).rejects.toMatchObject({
      errors: [errorA],
    })
    await bridge.flush()
    expect(failed).toHaveBeenCalledTimes(3)
  })

  it("drain captures reads, settles after failures, and does not wait for later calls", async () => {
    const storage = new MemoryStore()
    const bridge = new StorageBridge(storage, limits, () => {})
    const readGate = pause(storage, op => op === "load")
    const error = new Error("read failed")
    const originalLoad = storage.load.bind(storage)
    storage.load = async key => {
      await originalLoad(key)
      throw error
    }
    const reading = withId(id => bridge.records(id)).catch(e => e)
    const drained = bridge.drain()
    await readGate.entered
    const lateGate = pause(storage, op => op === "save")
    const later = withId(id => bridge.saveSedimentreeId(id))
    // No mutation was accepted at the time of this empty filtered barrier.
    await bridge.flush([])
    readGate.release()
    await drained
    expect(await reading).toBe(error)
    await lateGate.entered
    expect(storage.active).toBe(1)
    lateGate.release()
    await later
    // Read failures are not mutation failures.
    await bridge.flush()
  })

  it("a throwing failed callback does not replace the error or poison subsequent work", async () => {
    const storage = new MemoryStore()
    const bridge = new StorageBridge(
      storage,
      limits,
      () => {},
      () => {
        throw new Error("callback")
      }
    )
    const error = new Error("remove")
    storage.before = async () => {
      throw error
    }
    await expect(withId(id => bridge.cleanup(id))).rejects.toBe(error)
    await bridge.drain()
    storage.before = undefined
    await withId(id => bridge.saveSedimentreeId(id))
    await expect(bridge.flush()).rejects.toMatchObject({ errors: [error] })
    await bridge.flush()
  })
})
