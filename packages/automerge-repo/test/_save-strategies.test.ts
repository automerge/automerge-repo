/**
 * Strategy bake-off for SubductionSource#save.
 *
 * Mimics the structure of #save: capture handle.doc(), getHeads,
 * getChangesMetaSince, loop addCommit. Tests how each strategy
 * behaves under concurrent invocations. Times the total wall clock
 * for `flush + shutdown`-equivalent.
 *
 * Run with:
 *   RUN_PERF=1 PERF_N=1000 pnpm exec vitest run --no-file-parallelism \
 *     --project @automerge/automerge-repo test/_save-strategies.test.ts
 */

import * as subductionModule from "@automerge/automerge-subduction"
import { next as Automerge } from "@automerge/automerge/slim"
import { beforeAll, describe, test } from "vitest"

import { DummyStorageAdapter } from "../src/helpers/DummyStorageAdapter.js"
import { initSubduction } from "../src/initSubduction.js"
import { HashRing } from "../src/helpers/HashRing.js"
import { automergeMeta } from "../src/subduction/helpers.js"
import { SubductionStorageBridge } from "../src/subduction/storage.js"
import { throttle } from "../src/helpers/throttle.js"

beforeAll(async () => {
  await initSubduction()
})

const SHOULD_RUN = process.env.RUN_PERF === "1"
const N = Number(process.env.PERF_N ?? 1000)
const maybeDescribe = SHOULD_RUN ? describe : describe.skip

// ── Fake "handle" that just holds a doc reference ────────────────────

class FakeHandle {
  doc: Automerge.Doc<{ count: number }>

  constructor(initial: Automerge.Doc<{ count: number }>) {
    this.doc = initial
  }

  change(cb: (d: { count: number }) => void) {
    this.doc = Automerge.change(this.doc, cb)
  }
}

// ── Per-entry state used by all strategies ───────────────────────────

interface Entry {
  handle: FakeHandle
  sedimentreeId: any
  lastSavedHeads: Set<string>
  recentlySavedHashes: HashRing
  recentlySavedHeads: HashRing
  saveSettled: Promise<void>
  saveInProgress: boolean
  saveAgainAfter: boolean
}

const newEntry = (handle: FakeHandle, sid: any): Entry => ({
  handle,
  sedimentreeId: sid,
  lastSavedHeads: new Set(),
  recentlySavedHashes: new HashRing(256),
  recentlySavedHeads: new HashRing(10000),
  saveSettled: Promise.resolve(),
  saveInProgress: false,
  saveAgainAfter: false,
})

// ── The actual addCommit loop, parameterized by what we already saved ──

async function addCommitsLoop(
  entry: Entry,
  doc: Automerge.Doc<{ count: number }>,
  subduction: any,
  sinceHeads: string[],
) {
  const { CommitId } = subductionModule as any
  const meta = Automerge.getChangesMetaSince(doc, sinceHeads)
  await Promise.all(
    meta.map(async m => {
      if (!entry.recentlySavedHashes.add(m.hash)) return
      const inner = automergeMeta(doc)
      const commitBytes = inner.getChangeByHash(m.hash)
      const head = CommitId.fromHexString(m.hash)
      const parents = m.deps.map((d: string) => CommitId.fromHexString(d))
      await subduction.addCommit(
        entry.sedimentreeId,
        head,
        parents,
        commitBytes,
      )
    }),
  )
  return meta.length
}

// ── Strategies ───────────────────────────────────────────────────────

type SaveFn = (entry: Entry, subduction: any) => Promise<void>

// S0: current production — serialize via promise chain
const saveSerialize: SaveFn = async (entry, subduction) => {
  const previous = entry.saveSettled
  let resolve!: () => void
  entry.saveSettled = new Promise<void>(r => {
    resolve = r
  })
  try {
    await previous
    const doc = entry.handle.doc
    if (!doc) return
    const currentHeads = Automerge.getHeads(doc)
    const currentSet = new Set(currentHeads)
    if (
      currentSet.size === entry.lastSavedHeads.size &&
      [...currentSet].every(h => entry.lastSavedHeads.has(h))
    ) {
      return
    }
    const previousHeads = entry.lastSavedHeads
    entry.lastSavedHeads = currentSet
    await addCommitsLoop(entry, doc, subduction, [...previousHeads])
  } finally {
    resolve()
  }
}

// S1: large ring buffer (10k) for heads — concurrent
const saveBigRing: SaveFn = async (entry, subduction) => {
  const doc = entry.handle.doc
  if (!doc) return
  const currentHeads = Automerge.getHeads(doc)
  if (currentHeads.every(h => entry.recentlySavedHeads.has(h))) return
  const previousHeads = new Set<string>()
  // Walk the existing ring contents — we don't have a values() method
  // so we do has-checks below. For previousHeads, just use everything
  // currently in the ring + we add ours synchronously.
  // For now use empty (full scan + dedup); the dedup in addCommitsLoop
  // will catch repeats.
  for (const h of currentHeads) entry.recentlySavedHeads.add(h)
  await addCommitsLoop(entry, doc, subduction, [...previousHeads])
}

// S2: hash-only dedup, no head check, no serialization
const saveHashOnly: SaveFn = async (entry, subduction) => {
  const doc = entry.handle.doc
  if (!doc) return
  await addCommitsLoop(entry, doc, subduction, [])
}

// S3: clone the doc defensively before working with it
const saveClone: SaveFn = async (entry, subduction) => {
  const doc = entry.handle.doc
  if (!doc) return
  const currentHeads = Automerge.getHeads(doc)
  const currentSet = new Set(currentHeads)
  if (
    currentSet.size === entry.lastSavedHeads.size &&
    [...currentSet].every(h => entry.lastSavedHeads.has(h))
  ) {
    return
  }
  const previousHeads = entry.lastSavedHeads
  entry.lastSavedHeads = currentSet
  // Clone before doing wasm-mutating reads
  const cloned = Automerge.clone(doc)
  await addCommitsLoop(entry, cloned, subduction, [...previousHeads])
}

// S4: coalesce — if a save is in flight, just set a flag; when current
// finishes, loop back. Concurrent calls return immediately.
const saveCoalesce: SaveFn = async (entry, subduction) => {
  if (entry.saveInProgress) {
    entry.saveAgainAfter = true
    return
  }
  entry.saveInProgress = true
  try {
    do {
      entry.saveAgainAfter = false
      const doc = entry.handle.doc
      if (!doc) return
      const currentHeads = Automerge.getHeads(doc)
      const currentSet = new Set(currentHeads)
      if (
        currentSet.size === entry.lastSavedHeads.size &&
        [...currentSet].every(h => entry.lastSavedHeads.has(h))
      ) {
        continue
      }
      const previousHeads = entry.lastSavedHeads
      entry.lastSavedHeads = currentSet
      await addCommitsLoop(entry, doc, subduction, [...previousHeads])
    } while (entry.saveAgainAfter)
  } finally {
    entry.saveInProgress = false
  }
}

// S6: track in-flight head sets — second concurrent call early-returns
// if its currentHeads matches any in-flight or already-saved set
const inFlightHeads = new WeakMap<Entry, Set<string>[]>()
const saveInFlightHeads: SaveFn = async (entry, subduction) => {
  const doc = entry.handle.doc
  if (!doc) return
  const currentHeads = Automerge.getHeads(doc)
  const currentSet = new Set(currentHeads)

  // Check already-saved
  if (
    currentSet.size === entry.lastSavedHeads.size &&
    [...currentSet].every(h => entry.lastSavedHeads.has(h))
  ) {
    return
  }
  // Check in-flight
  const inFlight = inFlightHeads.get(entry) ?? []
  for (const set of inFlight) {
    if (
      set.size === currentSet.size &&
      [...currentSet].every(h => set.has(h))
    ) {
      return
    }
  }

  // Stake claim
  const previousHeads = entry.lastSavedHeads
  entry.lastSavedHeads = currentSet
  inFlight.push(currentSet)
  inFlightHeads.set(entry, inFlight)

  try {
    await addCommitsLoop(entry, doc, subduction, [...previousHeads])
  } finally {
    const idx = inFlight.indexOf(currentSet)
    if (idx >= 0) inFlight.splice(idx, 1)
  }
}

// S5: capture changes synchronously upfront
const saveSnapshotChanges: SaveFn = async (entry, subduction) => {
  const { CommitId } = subductionModule as any
  const doc = entry.handle.doc
  if (!doc) return
  const currentHeads = Automerge.getHeads(doc)
  const currentSet = new Set(currentHeads)
  if (
    currentSet.size === entry.lastSavedHeads.size &&
    [...currentSet].every(h => entry.lastSavedHeads.has(h))
  ) {
    return
  }
  const previousHeads = entry.lastSavedHeads
  entry.lastSavedHeads = currentSet

  // SYNCHRONOUSLY extract everything we need. No await between these
  // calls.
  const meta = Automerge.getChangesMetaSince(doc, [...previousHeads])
  const inner = automergeMeta(doc)
  const work = meta.map(m => ({
    hash: m.hash,
    bytes: inner.getChangeByHash(m.hash),
    head: CommitId.fromHexString(m.hash),
    parents: m.deps.map((d: string) => CommitId.fromHexString(d)),
  }))

  // NOW do the awaits.
  await Promise.all(
    work.map(async w => {
      if (!entry.recentlySavedHashes.add(w.hash)) return
      await subduction.addCommit(
        entry.sedimentreeId,
        w.head,
        w.parents,
        w.bytes,
      )
    }),
  )
}

const STRATEGIES: Record<string, SaveFn> = {
  serialize: saveSerialize,
  bigRing: saveBigRing,
  hashOnly: saveHashOnly,
  clone: saveClone,
  coalesce: saveCoalesce,
  snapshotChanges: saveSnapshotChanges,
  inFlightHeads: saveInFlightHeads,
}

// ── Bench harness ────────────────────────────────────────────────────

async function benchOnce(strategyName: string, n: number) {
  const { Subduction, MemorySigner, SedimentreeId } = subductionModule as any

  const adapter = new DummyStorageAdapter()
  const storage = new SubductionStorageBridge(adapter)
  const signer = new MemorySigner()
  const subduction = await Subduction.hydrate(signer, storage)

  // Build doc with N changes (simulating what the user did before
  // shutdown was called)
  let doc = Automerge.init<{ count: number }>()
  doc = Automerge.change(doc, d => {
    d.count = 0
  })
  for (let i = 1; i <= n; i++) {
    doc = Automerge.change(doc, d => {
      d.count = i
    })
  }

  const handle = new FakeHandle(doc)
  const sid = SedimentreeId.fromBytes(
    new Uint8Array(32).fill(strategyName.charCodeAt(0) % 256),
  )
  const entry = newEntry(handle, sid)

  const saveFn = STRATEGIES[strategyName]

  // Simulate concurrent #save calls. Configure how many.
  const concurrency = Number(process.env.PERF_CONCURRENCY ?? 2)
  const tStart = performance.now()
  const promises: Promise<void>[] = []
  for (let i = 0; i < concurrency; i++) {
    promises.push(saveFn(entry, subduction))
  }
  await Promise.all(promises)
  await entry.saveSettled
  const tEnd = performance.now()

  return tEnd - tStart
}

maybeDescribe("save strategy bake-off", () => {
  test(`compare strategies, n=${N}`, { timeout: 5 * 60 * 1000 }, async () => {
    // eslint-disable-next-line no-console
    console.log(`\n=== n=${N} (memory adapter) ===`)
    // Warmup
    for (const name of Object.keys(STRATEGIES)) {
      await benchOnce(name, 10)
    }

    // Real runs (best-of-3)
    for (const name of Object.keys(STRATEGIES)) {
      const times = []
      for (let i = 0; i < 3; i++) {
        times.push(await benchOnce(name, N))
      }
      const min = Math.min(...times)
      const max = Math.max(...times)
      const median = times.sort((a, b) => a - b)[1]
      // eslint-disable-next-line no-console
      console.log(
        `  ${name.padEnd(20)} median=${median.toFixed(0).padStart(5)}ms  ` +
          `(min=${min.toFixed(0).padStart(5)}ms max=${max.toFixed(0).padStart(5)}ms)`,
      )
    }
  })
})
