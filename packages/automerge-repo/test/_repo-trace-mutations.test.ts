/**
 * Trace what's mutating the handle during the perf bench scenario, to
 * find out where the divergent heads come from in concurrent #save
 * calls.
 *
 * Run with:
 *   RUN_PERF=1 PERF_N=200 pnpm exec vitest run --no-file-parallelism \
 *     --project @automerge/automerge-repo test/_repo-trace-mutations.test.ts
 */

import { next as Automerge } from "@automerge/automerge/slim"
import { beforeAll, describe, test } from "vitest"

import { Repo } from "../src/Repo.js"
import { DummyStorageAdapter } from "../src/helpers/DummyStorageAdapter.js"
import { initSubduction } from "../src/initSubduction.js"

beforeAll(async () => {
  await initSubduction()
})

const SHOULD_RUN = process.env.RUN_PERF === "1"
const N = Number(process.env.PERF_N ?? 200)
const maybeDescribe = SHOULD_RUN ? describe : describe.skip

maybeDescribe("trace handle mutations during shutdown", () => {
  test(`n=${N}`, { timeout: 60_000 }, async () => {
    const adapter = new DummyStorageAdapter()
    const repo = new Repo({ storage: adapter, network: [] })

    const handle = repo.create<{ count: number }>({ count: 0 })
    await handle.whenReady()

    // Hook the handle so we observe every update() call
    const originalUpdate = handle.update.bind(handle)
    let updateCount = 0
    ;(handle as any).update = (cb: any) => {
      updateCount++
      const before = Automerge.getHeads(handle.doc()).join(",").slice(0, 16)
      const result = originalUpdate(cb)
      const after = Automerge.getHeads(handle.doc()).join(",").slice(0, 16)
      if (before !== after) {
        // eslint-disable-next-line no-console
        console.log(
          `[handle.update #${updateCount}] heads ${before} -> ${after}, stack:\n` +
            new Error().stack?.split("\n").slice(2, 8).join("\n"),
        )
      }
      return result
    }

    // Also hook handle.heads and Automerge.getHeads to detect external observers
    const observe = (label: string) => {
      const heads = Automerge.getHeads(handle.doc()).join(",").slice(0, 16)
      // eslint-disable-next-line no-console
      console.log(`[observe ${label}] heads=${heads}`)
    }

    observe("after create")

    for (let i = 1; i <= N; i++) {
      handle.change(d => {
        d.count = i
      })
    }
    observe("after mutate loop")

    await repo.flush()
    observe("after flush")

    // eslint-disable-next-line no-console
    console.log(`--- shutdown begins ---`)
    await repo.shutdown()
    observe("after shutdown")

    // eslint-disable-next-line no-console
    console.log(`Total handle.update() calls: ${updateCount}`)
  })
})
