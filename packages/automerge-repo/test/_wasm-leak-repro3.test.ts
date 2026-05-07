/**
 * Trying to repro the head drift observed in the integration bench.
 *
 * The bench uses Repo + handle.change → eventually a #save loop runs
 * subduction.addCommit for each change, and afterwards the doc's
 * heads are observably DIFFERENT.
 *
 * This file tries to find the minimum reproducer for that drift.
 */

import * as subductionModule from "@automerge/automerge-subduction"
import { next as Automerge } from "@automerge/automerge/slim"
import { beforeAll, describe, expect, test } from "vitest"

import { DummyStorageAdapter } from "../src/helpers/DummyStorageAdapter.js"
import { initSubduction } from "../src/initSubduction.js"
import { automergeMeta } from "../src/subduction/helpers.js"
import { SubductionStorageBridge } from "../src/subduction/storage.js"

beforeAll(async () => {
  await initSubduction()
})

const SHOULD_RUN = process.env.RUN_PERF === "1"
const maybeDescribe = SHOULD_RUN ? describe : describe.skip

maybeDescribe("integration repro", () => {
  test(
    "doc head changes after addCommit loop runs",
    { timeout: 60_000 },
    async () => {
      const { Subduction, MemorySigner, SedimentreeId, CommitId } =
        subductionModule as any

      const adapter = new DummyStorageAdapter()
      const storage = new SubductionStorageBridge(adapter)
      const signer = new MemorySigner()
      const subduction = await Subduction.hydrate(signer, storage)

      // Build doc with 500 changes
      let doc = Automerge.init<{ count: number }>()
      doc = Automerge.change(doc, d => {
        d.count = 0
      })
      for (let i = 1; i <= 500; i++) {
        doc = Automerge.change(doc, d => {
          d.count = i
        })
      }

      const headsBefore = Automerge.getHeads(doc)
        .join(",")
        .slice(0, 16)

      // Pretend to be the bench's #save loop
      const sid = SedimentreeId.fromBytes(new Uint8Array(32).fill(99))
      const meta = Automerge.getChangesMetaSince(doc, [])

      await Promise.all(
        meta.map(async m => {
          const inner = automergeMeta(doc)
          const commitBytes = inner.getChangeByHash(m.hash)
          const head = CommitId.fromHexString(m.hash)
          const parents = m.deps.map((d: string) =>
            CommitId.fromHexString(d),
          )
          await subduction.addCommit(sid, head, parents, commitBytes)
        }),
      )

      const headsAfter = Automerge.getHeads(doc).join(",").slice(0, 16)
      // eslint-disable-next-line no-console
      console.log(`headsBefore=${headsBefore} headsAfter=${headsAfter}`)
      expect(headsAfter).toBe(headsBefore)
    },
  )

  // What if subduction emits commit-saved events that the bridge fires
  // and there's some side-effect we're not aware of? Run with a listener
  // attached.
  test(
    "doc head with commit-saved listener attached",
    { timeout: 60_000 },
    async () => {
      const { Subduction, MemorySigner, SedimentreeId, CommitId } =
        subductionModule as any

      const adapter = new DummyStorageAdapter()
      const storage = new SubductionStorageBridge(adapter)
      const signer = new MemorySigner()
      const subduction = await Subduction.hydrate(signer, storage)

      let listenerCalls = 0
      storage.on("commit-saved", () => {
        listenerCalls++
      })

      let doc = Automerge.init<{ count: number }>()
      doc = Automerge.change(doc, d => {
        d.count = 0
      })
      for (let i = 1; i <= 500; i++) {
        doc = Automerge.change(doc, d => {
          d.count = i
        })
      }

      const headsBefore = Automerge.getHeads(doc).join(",").slice(0, 16)

      const sid = SedimentreeId.fromBytes(new Uint8Array(32).fill(98))
      const meta = Automerge.getChangesMetaSince(doc, [])

      await Promise.all(
        meta.map(async m => {
          const inner = automergeMeta(doc)
          const commitBytes = inner.getChangeByHash(m.hash)
          const head = CommitId.fromHexString(m.hash)
          const parents = m.deps.map((d: string) =>
            CommitId.fromHexString(d),
          )
          await subduction.addCommit(sid, head, parents, commitBytes)
        }),
      )

      const headsAfter = Automerge.getHeads(doc).join(",").slice(0, 16)
      // eslint-disable-next-line no-console
      console.log(
        `listenerCalls=${listenerCalls} headsBefore=${headsBefore} headsAfter=${headsAfter}`,
      )
      expect(headsAfter).toBe(headsBefore)
    },
  )
})
