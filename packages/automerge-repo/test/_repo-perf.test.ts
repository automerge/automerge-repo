/**
 * Standalone perf benchmark for `Repo` with no network adapters, just
 * storage. Measures the cost of `change()`, `flush()`, and -- the bit
 * we especially care about -- `shutdown()` as a function of mutation
 * count.
 *
 * Adapted from
 *   https://github.com/dxos/dxos/blob/mykola/subduction/packages/core/echo/echo-pipeline/src/automerge/_repo-perf.test.ts
 *
 * The upstream version uses a LevelDB storage adapter that doesn't
 * exist in this repo. We run the same harness against three storage
 * variants we _do_ have:
 *
 *   - `memory`  : in-process `DummyStorageAdapter` (no I/O)
 *   - `nodefs`  : `NodeFSStorageAdapter` over a `mkdtemp` directory
 *                 with the standard write-to-temp + fsync + rename
 *                 atomic-write pattern
 *
 * This file is _not_ part of the regular test suite. It is gated on
 * the `RUN_PERF` env var so it doesn't slow down `pnpm test`. Run it
 * explicitly with:
 *
 *   RUN_PERF=1 pnpm --filter @automerge/automerge-repo \
 *     vitest run --no-file-parallelism test/_repo-perf.test.ts
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { beforeAll, describe, test } from "vitest"

import { NodeFSStorageAdapter } from "../../automerge-repo-storage-nodefs/src/index.js"
import { Repo } from "../src/Repo.js"
import { DummyStorageAdapter } from "../src/helpers/DummyStorageAdapter.js"
import { initSubduction } from "../src/initSubduction.js"
import type { StorageAdapterInterface } from "../src/storage/StorageAdapterInterface.js"

// ── Benchmark gating ─────────────────────────────────────────────────
//
// Gate on RUN_PERF=1 so this file is a no-op during regular test
// runs. We use describe.skip rather than test.skipIf so that the
// per-iteration timing output isn't drowned out by skipped-test
// noise.
const SHOULD_RUN = process.env.RUN_PERF === "1"
const maybeDescribe = SHOULD_RUN ? describe : describe.skip

// ── Storage harness ──────────────────────────────────────────────────

interface StorageHarness {
  label: string
  storage: StorageAdapterInterface
  teardown: () => Promise<void>
}

const memoryHarness = (): StorageHarness => ({
  label: "memory",
  storage: new DummyStorageAdapter(),
  teardown: async () => {},
})

const nodefsHarness = (): StorageHarness => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automerge-repo-perf-"))
  return {
    label: "nodefs",
    storage: new NodeFSStorageAdapter(dir),
    teardown: async () => {
      fs.rmSync(dir, { force: true, recursive: true })
    },
  }
}

// ── Single measurement ───────────────────────────────────────────────

const measure = async (
  harnessFactory: () => StorageHarness,
  label: string,
  mutationCount: number,
) => {
  const harness = harnessFactory()

  try {
    const tCreate0 = performance.now()
    const repo = new Repo({
      storage: harness.storage,
      network: [],
    })
    const tCreate1 = performance.now()

    const handle = repo.create<{ count: number }>({ count: 0 })
    await handle.whenReady()
    const tDocReady = performance.now()

    for (let i = 1; i <= mutationCount; i++) {
      handle.change(doc => {
        doc.count = i
      })
    }
    const tMutated = performance.now()

    await repo.flush()
    const tFlushed = performance.now()

    await repo.shutdown()
    const tShutdown = performance.now()

    const fmt = (ms: number, width = 4) =>
      ms.toFixed(0).padStart(width)

    // eslint-disable-next-line no-console
    console.log(
      `[${harness.label.padEnd(6)} ${label.padEnd(8)}] ` +
        `mutations=${String(mutationCount).padStart(5)}  ` +
        `repo.new=${fmt(tCreate1 - tCreate0)}ms  ` +
        `create+ready=${fmt(tDocReady - tCreate1)}ms  ` +
        `mutate=${fmt(tMutated - tDocReady)}ms  ` +
        `flush=${fmt(tFlushed - tMutated, 5)}ms  ` +
        `shutdown=${fmt(tShutdown - tFlushed, 5)}ms  ` +
        `TOTAL=${fmt(tShutdown - tCreate0, 5)}ms`,
    )
  } finally {
    await harness.teardown()
  }
}

// ── Test suite ───────────────────────────────────────────────────────

beforeAll(async () => {
  await initSubduction()
})

// Mutation counts to sweep across. The default range stops at 2000
// because shutdown currently scales superlinearly with mutation
// count -- 5000 mutations takes >2 minutes per run on the in-memory
// adapter as of 2026-05-06. Override with `PERF_SCALE=10,100,1000`
// to run a custom sweep, or `PERF_SCALE=10,100,500,1000,2000,5000`
// to include the slow tail when investigating shutdown regressions.
const SCALE = process.env.PERF_SCALE
  ? process.env.PERF_SCALE.split(",").map(s => Number(s.trim()))
  : [10, 100, 500, 1000, 2000]

// 30 minutes. Big enough to absorb the superlinear shutdown tail at
// the largest mutation counts; vitest will still kill us if we hang
// on a deadlock.
const PERF_TIMEOUT = 30 * 60 * 1000

maybeDescribe("automerge-repo perf (no networks, just storage)", () => {
  test("memory: mutation count scaling", { timeout: PERF_TIMEOUT }, async () => {
    // Warm up (Wasm init, JIT, allocator).
    await measure(memoryHarness, "warmup", 10)
    // eslint-disable-next-line no-console
    console.log("---")
    for (const n of SCALE) {
      await measure(memoryHarness, "bench", n)
    }
  })

  test("nodefs: mutation count scaling", { timeout: PERF_TIMEOUT }, async () => {
    // Warm up (Wasm init, JIT, fs cache).
    await measure(nodefsHarness, "warmup", 10)
    // eslint-disable-next-line no-console
    console.log("---")
    for (const n of SCALE) {
      await measure(nodefsHarness, "bench", n)
    }
  })

  // Shutdown-focused micro-benchmark: every iteration boots a fresh
  // repo, applies `n` mutations, flushes, and then times _only_ the
  // shutdown call. Useful when investigating regressions in the
  // shutdown sequence (Subduction quiesce, final flush, storage
  // close) without flush time bleeding into the number.
  test("shutdown isolation", { timeout: PERF_TIMEOUT }, async () => {
    for (const factory of [memoryHarness, nodefsHarness]) {
      // eslint-disable-next-line no-console
      console.log(`--- shutdown isolation (${factory().label}) ---`)
      for (const n of SCALE) {
        const harness = factory()
        try {
          const repo = new Repo({ storage: harness.storage, network: [] })
          const handle = repo.create<{ count: number }>({ count: 0 })
          await handle.whenReady()

          for (let i = 1; i <= n; i++) {
            handle.change(doc => {
              doc.count = i
            })
          }
          await repo.flush()

          const t0 = performance.now()
          await repo.shutdown()
          const t1 = performance.now()
          // eslint-disable-next-line no-console
          console.log(
            `[${harness.label.padEnd(6)}] mutations=${String(n).padStart(5)}  ` +
              `shutdown=${(t1 - t0).toFixed(1).padStart(7)}ms`,
          )
        } finally {
          await harness.teardown()
        }
      }
    }
  })
})
