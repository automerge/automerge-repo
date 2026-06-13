/**
 * Perf sweep for `loadRange` over many documents (the bulk-load path).
 *
 * Benches whatever adapter is in `../src` — to compare two revisions,
 * run it on each. For example, to reproduce the before/after numbers
 * for the prefix-trie key index:
 *
 *   # before (old startsWith scan), from the PR branch:
 *   git checkout <base-sha> -- packages/automerge-repo-storage-nodefs/src/index.ts
 *   RUN_PERF=1 pnpm exec vitest run \
 *     packages/automerge-repo-storage-nodefs/test/LoadRangePerf.test.ts \
 *     --disable-console-intercept
 *   git checkout HEAD -- packages/automerge-repo-storage-nodefs/src/index.ts
 *
 *   # after (current source): same command, unmodified tree
 *
 * Workload mimics `StorageSubsystem.loadDocData` on a warm adapter
 * (cache populated by the saves that created the data): N docs x 3
 * chunks, then per doc one `loadRange([id, "snapshot"])` plus one
 * `loadRange([id, "incremental"])`. Reports medians of 3 reps and the
 * per-doubling growth factor T(2N)/T(N) — the machine-load-immune
 * signal: ~4x per doubling is quadratic, ~2x is linear.
 */

import crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, it } from "vitest"
import { NodeFSStorageAdapter } from "../src"

const SIZES = [250, 500, 1000, 2000, 4000, 8000]
const REPS = 3
const CHUNK_TYPES = ["snapshot", "incremental", "sync-state"] as const

/** Random 27/28-char ids mimicking bs58check DocumentIds. */
const makeIds = (n: number): string[] =>
  Array.from({ length: n }, () =>
    crypto
      .randomBytes(21)
      .toString("base64url")
      .replace(/[-_]/g, "x")
      .slice(0, 27 + (Math.random() < 0.5 ? 1 : 0))
  )

const populate = async (adapter: NodeFSStorageAdapter, ids: string[]) => {
  const payload = crypto.randomBytes(64)
  for (const id of ids) {
    for (const type of CHUNK_TYPES) {
      await adapter.save(
        [id, type, crypto.randomBytes(8).toString("hex")],
        payload
      )
    }
  }
}

/** The StorageSubsystem.loadDocData query pattern, for every doc. */
const sweep = async (
  adapter: NodeFSStorageAdapter,
  ids: string[]
): Promise<number> => {
  const t0 = performance.now()
  for (const id of ids) {
    await adapter.loadRange([id, "snapshot"])
    await adapter.loadRange([id, "incremental"])
  }
  return performance.now() - t0
}

const median = (xs: number[]): number =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

describe.skipIf(!process.env.RUN_PERF)("loadRange bulk sweep", () => {
  it(
    "per-doc loadRange over N docs, warm cache",
    { timeout: 1_800_000 },
    async () => {
      const rows: Array<{ n: number; ms: number }> = []

      for (const n of SIZES) {
        const ids = makeIds(n)
        const times: number[] = []

        for (let rep = 0; rep < REPS; rep++) {
          const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nodefs-perf-"))
          try {
            const adapter = new NodeFSStorageAdapter(dir)
            await populate(adapter, ids)
            times.push(await sweep(adapter, ids))
          } finally {
            fs.rmSync(dir, { force: true, recursive: true })
          }
        }

        rows.push({ n, ms: median(times) })
      }

      console.log("\nN docs | sweep (ms) | growth vs previous")
      console.log("-------|------------|-------------------")
      for (let i = 0; i < rows.length; i++) {
        const growth =
          i === 0 ? "—" : `${(rows[i].ms / rows[i - 1].ms).toFixed(2)}x`
        console.log(
          `${String(rows[i].n).padStart(6)} | ${rows[i].ms
            .toFixed(1)
            .padStart(10)} | ${growth}`
        )
      }
      console.log(
        "\n(~2x growth per doubling = linear in N; ~4x or worse = quadratic)"
      )
    }
  )
})
