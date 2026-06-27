/**
 * Verifies the `SubductionSource` timing instrumentation emits records for the
 * network (`sync-round`) and storage (`save`) phases.
 *
 * The materialization phases are covered where they reliably fire:
 * `get-blobs` / `apply-snapshot` / `cold-load` in `DocBuildOffload.browser`
 * (real IndexedDB cold load), the worker phases in `DocBuild.browser`, and
 * `flush-inbound` in `Topology` (live two-peer sync).
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest"

import { Repo } from "../../src/Repo.js"
import { DummyStorageAdapter } from "../../src/helpers/DummyStorageAdapter.js"
import { initSubduction } from "../../src/initSubduction.js"
import { subductionTimings } from "../../src/subduction/timing.js"

beforeAll(async () => {
  await initSubduction()
})

const pause = (ms: number) => new Promise(r => setTimeout(r, ms))

async function waitFor(fn: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return
    await pause(25)
  }
  throw new Error("waitFor timed out")
}

const has = (phase: string) =>
  subductionTimings.records.some(r => r.phase === phase)

describe("SubductionSource timing instrumentation", () => {
  afterEach(() => {
    subductionTimings.clear()
  })

  it("records `save` and `sync-round` for local writes", async () => {
    subductionTimings.clear().enable()
    const storage = new DummyStorageAdapter()
    const repo = new Repo({ storage, network: [] })
    try {
      const handle = repo.create<{ n: number }>({ n: 0 })
      handle.change(d => {
        d.n = 1
      })
      await repo.flush()

      const save = subductionTimings.records.find(r => r.phase === "save")
      expect(save).toBeDefined()
      expect(save!.outcome).toBe("ok")
      expect(save!.extra?.commits).toBeGreaterThan(0)
      expect(save!.source).toBeTruthy()
      expect(save!.wallTs).toBeTypeOf("number")

      // The save tail arms an immediate `#doSync`; with no peers it still
      // records a (peers: 0) sync round.
      await waitFor(() => has("sync-round"), 5_000)
      const sync = subductionTimings.records.find(
        r => r.phase === "sync-round"
      )!
      expect(sync.outcome).toBe("ok")
      expect(sync.extra?.peers).toBe(0)
    } finally {
      await repo.shutdown()
    }
  }, 15_000)

  it("records `find` end-to-end on a cold load", async () => {
    const storage = new DummyStorageAdapter()
    const repo1 = new Repo({ storage, network: [] })
    let url: string
    try {
      const handle = repo1.create<{ n: number }>({ n: 0 })
      handle.change(d => {
        d.n = 1
      })
      url = handle.url
      await repo1.flush()
    } finally {
      await repo1.shutdown()
    }

    subductionTimings.clear().enable()
    const repo2 = new Repo({ storage, network: [] })
    try {
      const handle = await repo2.find<{ n: number }>(url)
      await handle.whenReady()
      const find = subductionTimings.records.find(r => r.phase === "find")
      expect(find).toBeDefined()
      expect(find!.outcome).toBe("ok")
      expect(find!.ms).toBeGreaterThanOrEqual(0)
      expect(find!.sid).toBeTruthy()
    } finally {
      await repo2.shutdown()
    }
  }, 15_000)

  it("timeline() reports per-phase wall-clock start/end offsets (not summed work)", () => {
    subductionTimings.clear().enable()
    // Records are stamped at the END of the op, so start = ts - ms.
    subductionTimings.record({
      ts: 100,
      phase: "get-blobs",
      outcome: "ok",
      ms: 20,
    }) // [80,100]
    subductionTimings.record({
      ts: 250,
      phase: "apply-inline",
      outcome: "ok",
      ms: 50,
    }) // [200,250]
    subductionTimings.record({
      ts: 130,
      phase: "get-blobs",
      outcome: "ok",
      ms: 10,
    }) // [120,130]

    const tl = subductionTimings.timeline()
    // Overall window spans the earliest start to the latest end.
    expect(tl.startMs).toBe(80)
    expect(tl.endMs).toBe(250)
    expect(tl.spanMs).toBe(170)
    // get-blobs covers [80,130] (two occurrences), span 50 — NOT 20+10=30.
    expect(tl.phases["get-blobs"].startMs).toBe(80)
    expect(tl.phases["get-blobs"].endMs).toBe(130)
    expect(tl.phases["get-blobs"].spanMs).toBe(50)
    expect(tl.phases["get-blobs"].n).toBe(2)
    expect(tl.phases["apply-inline"].startMs).toBe(200)
    expect(tl.phases["apply-inline"].endMs).toBe(250)
    subductionTimings.disable().clear()
  })

  it("tags records with source + wallTs and aggregates by phase/outcome", async () => {
    subductionTimings.clear().enable()
    const storage = new DummyStorageAdapter()
    const repo = new Repo({ storage, network: [] })
    try {
      const handle = repo.create<{ n: number }>({ n: 0 })
      handle.change(d => {
        d.n = 1
      })
      await repo.flush()
      await waitFor(() => has("sync-round"), 5_000)

      const summary = subductionTimings.summary()
      expect(summary["save"]?.ok).toBeGreaterThan(0)
      expect(summary["sync-round"]?.n).toBeGreaterThan(0)
      // Every record is tagged so a merged cross-thread view stays attributable.
      for (const r of subductionTimings.records) {
        expect(r.source).toBeTruthy()
        expect(r.wallTs).toBeTypeOf("number")
      }
    } finally {
      await repo.shutdown()
    }
  }, 15_000)
})
