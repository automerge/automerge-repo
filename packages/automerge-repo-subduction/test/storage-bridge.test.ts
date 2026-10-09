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

class MemoryStore implements LocalByteStore {
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
      const bridge = new StorageBridge(storage, () => {})
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
        signed.set(record, signedBytes(value))
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

describe("StorageBridge native transaction serialization", () => {
  it("rejects a signed record under a different storage key", async () => {
    const storage = new MemoryStore()
    const bridge = new StorageBridge(storage, () => {})
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
      const saved = vi.fn()
      const bridge = new StorageBridge(storage, saved)
      const record = kind === "commit" ? first : fragment
      // Signed for `tree`, offered under `other`, as a remote peer could.
      const write =
        path === "batch"
          ? batch(bridge, [record], other)
          : save(bridge, record, other)
      await expect(write).rejects.toThrow(/different tree/)
      expect(storage.values.size).toBe(0)
      expect(saved).not.toHaveBeenCalled()
    }
  )

  it("notifies when another bridge already saved an identical record without rewriting bytes", async () => {
    const storage = new MemoryStore()
    const firstSaved = vi.fn(),
      secondSaved = vi.fn()
    const a = new StorageBridge(storage, firstSaved)
    const b = new StorageBridge(storage, secondSaved)
    await save(a, first)
    await save(b, first)
    expect(firstSaved.mock.calls).toEqual([[tree, first]])
    expect(secondSaved.mock.calls).toEqual([[tree, first]])
    expect(storage.written).toHaveLength(1)
  })

  it("serializes same-head conflicts and exact retries, but allows both kinds", async () => {
    const storage = new MemoryStore(),
      saved = vi.fn(),
      failed = vi.fn()
    const bridge = new StorageBridge(storage, saved, failed)
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
    expect(storage.written).toHaveLength(2)
    expect(storage.maxActive).toBe(1)
  })

  it("owns decoded blobs after the stored frame changes", async () => {
    const storage = new MemoryStore()
    const bridge = new StorageBridge(storage, () => {})
    await save(bridge, first)
    const [record] = await withId(id => bridge.records(id))
    const frame = [...storage.values.values()][0]
    frame[frame.length - 1] ^= 0xff
    expect(record.blob).toEqual(first.blob)
  })

  it("saves without reading the rest of the tree's history", async () => {
    const storage = new MemoryStore()
    const bridge = new StorageBridge(storage, () => {})
    await save(bridge, first)
    await save(bridge, fragment)
    storage.calls.length = 0
    await save(bridge, second)
    // One same-key lookup and one write; no list or whole-history loads.
    const path = `subduction-v1/${tree.padEnd(64, "0")}/commits/${cid(2)}`
    expect(storage.calls).toEqual([`load:${path}`, `saveBatch:${path}`])
  })

  it("keeps batches, reads, and cleanup in acceptance order with freed inputs", async () => {
    const storage = new MemoryStore(),
      saved = vi.fn()
    const bridge = new StorageBridge(storage, saved)
    const gate = pause(
      storage,
      (op, key) => op === "saveBatch" && key.includes(cid(1))
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
    const bridge = new StorageBridge(storage, () => {})
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

  it("writes a batch and its tree marker together, or none of them", async () => {
    const storage = new MemoryStore(),
      saved = vi.fn(),
      failed = vi.fn()
    const bridge = new StorageBridge(storage, saved, failed)
    const error = new Error("disk failed")
    storage.before = async op => {
      if (op === "saveBatch") throw error
    }
    await expect(batch(bridge, [first, second, fragment])).rejects.toBe(error)
    expect(storage.values.size).toBe(0)
    expect(saved).not.toHaveBeenCalled()
    expect(failed.mock.calls).toEqual([[tree, error]])
    expect(await withId(id => bridge.containsSedimentreeId(id))).toBe(false)
    storage.before = undefined
    await batch(bridge, [first, second, fragment])
    expect(storage.calls.filter(call => call.startsWith("saveBatch:"))).toEqual(
      [expect.stringContaining("/id"), expect.stringContaining("/id")]
    )
    expect(storage.written).toHaveLength(4)
    expect(await withId(id => bridge.records(id))).toEqual([
      first,
      second,
      fragment,
    ])
  })

  it("reports an ambiguous batch save without notifying success; a retry recovers notifications", async () => {
    const storage = new MemoryStore(),
      saved = vi.fn(),
      failed = vi.fn()
    const bridge = new StorageBridge(storage, saved, failed)
    const error = new Error("saved, then rejected")
    storage.afterSave = () => {
      throw error
    }
    await expect(batch(bridge, [first, second, third])).rejects.toBe(error)
    expect(saved).not.toHaveBeenCalled()
    expect(failed.mock.calls).toEqual([[tree, error]])
    expect(await withId(id => bridge.records(id))).toEqual([
      first,
      second,
      third,
    ])
    await expect(bridge.flush()).rejects.toMatchObject({ errors: [error] })
    await expect(bridge.flush()).resolves.toBeUndefined()
    storage.afterSave = undefined
    const written = storage.written.length
    await batch(bridge, [first, second, third])
    // An exact retry doesn't rewrite records, but recovers missed notifications.
    expect(saved.mock.calls).toEqual([
      [tree, first],
      [tree, second],
      [tree, third],
    ])
    expect(
      storage.written.slice(written).filter(key => key.includes("/commits/"))
    ).toEqual([])
  })

  it("reports synchronous preparation errors through failed and flush", async () => {
    const storage = new MemoryStore(),
      failed = vi.fn()
    const bridge = new StorageBridge(storage, () => {}, failed)
    const wrong = N.CommitId.fromHexString(second.id)
    const value = N.SignedLooseCommit.tryDecode(signed.get(first)!)
    let operation: Promise<void>
    try {
      operation = withId(id => bridge.saveCommit(id, wrong, value, first.blob))
    } finally {
      wrong.free()
      value.free()
    }
    const flushed = bridge.flush()
    await expect(operation).rejects.toThrow(/key/)
    await expect(flushed).rejects.toMatchObject({ errors: [expect.any(Error)] })
    expect(failed.mock.calls[0][0]).toBe(tree)
    expect(storage.calls).toEqual([])
    await bridge.flush()
    await bridge.drain()
  })

  it("flush captures relevant pending/failed mutations, waits ALL and clears reported failures", async () => {
    const storage = new MemoryStore(),
      failed = vi.fn()
    const bridge = new StorageBridge(storage, () => {}, failed)
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
    const bridge = new StorageBridge(storage, () => {})
    const readGate = pause(storage, op => op === "loadPrefix")
    const error = new Error("read failed")
    const originalLoadPrefix = storage.loadPrefix.bind(storage)
    storage.loadPrefix = async prefix => {
      await originalLoadPrefix(prefix)
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
