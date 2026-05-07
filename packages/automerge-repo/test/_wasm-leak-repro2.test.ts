/**
 * Targeted repro 2: actually call subduction.addCommit concurrently
 * with getHeads on the same doc reference, to see if it's
 * subduction (not automerge) that's mutating things.
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

const buildDoc = (n: number) => {
  let doc = Automerge.init<{ count: number }>()
  doc = Automerge.change(doc, d => {
    d.count = 0
  })
  for (let i = 1; i <= n; i++) {
    doc = Automerge.change(doc, d => {
      d.count = i
    })
  }
  return doc
}

maybeDescribe("subduction-aware leak repro", () => {
  test("getHeads stable while addCommit calls are in flight", async () => {
    const { Subduction, MemorySigner, SedimentreeId, CommitId } =
      subductionModule as any

    const adapter = new DummyStorageAdapter()
    const storage = new SubductionStorageBridge(adapter)
    const signer = new MemorySigner()
    const subduction = await Subduction.hydrate(signer, storage)

    const doc = buildDoc(500)
    const headsBefore = Automerge.getHeads(doc).join(",")

    const sid = SedimentreeId.fromBytes(new Uint8Array(32).fill(7))
    const meta = Automerge.getChangesMetaSince(doc, [])

    const observations: string[] = []
    observations.push(Automerge.getHeads(doc).join(","))

    // Fire addCommit calls in parallel with periodic getHeads checks
    const addCommits = Promise.all(
      meta.map(async m => {
        const inner = automergeMeta(doc)
        const commitBytes = inner.getChangeByHash(m.hash)
        const head = CommitId.fromHexString(m.hash)
        const parents = m.deps.map((d: string) => CommitId.fromHexString(d))
        await subduction.addCommit(sid, head, parents, commitBytes)
      }),
    )

    const observer = (async () => {
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 10))
        observations.push(Automerge.getHeads(doc).join(","))
      }
    })()

    await Promise.all([addCommits, observer])
    observations.push(Automerge.getHeads(doc).join(","))

    const distinctValues = new Set(observations)
    // eslint-disable-next-line no-console
    console.log(
      `distinct head observations: ${distinctValues.size}, ` +
        `headsBefore=${headsBefore.slice(0, 16)}`,
    )
    if (distinctValues.size > 1) {
      // eslint-disable-next-line no-console
      console.log(`samples:`)
      for (const v of distinctValues) {
        // eslint-disable-next-line no-console
        console.log(`  ${v.slice(0, 16)}`)
      }
    }

    expect(distinctValues.size).toBe(1)
  })

  // Two "save" tasks running concurrently — exactly the SubductionSource
  // shape. Both capture handle.doc() and run getChangeByHash + addCommit
  // for every change. Do they observe consistent heads from their
  // captured docs?
  test("two concurrent save tasks see consistent heads", async () => {
    const { Subduction, MemorySigner, SedimentreeId, CommitId } =
      subductionModule as any

    const adapter = new DummyStorageAdapter()
    const storage = new SubductionStorageBridge(adapter)
    const signer = new MemorySigner()
    const subduction = await Subduction.hydrate(signer, storage)

    const doc = buildDoc(500)
    const headsAtStart = Automerge.getHeads(doc).join(",")
    const sid = SedimentreeId.fromBytes(new Uint8Array(32).fill(8))
    const meta = Automerge.getChangesMetaSince(doc, [])

    const headsObserved: string[] = []

    const saveTask = async (label: string) => {
      // Capture local "snapshot"
      const cap = doc
      const heads0 = Automerge.getHeads(cap).join(",")
      headsObserved.push(`${label}-start:${heads0.slice(0, 8)}`)

      // Iterate and call addCommit for half the changes (to maximize
      // overlap between the two tasks)
      const half = label === "A" ? meta.slice(0, 250) : meta.slice(250)
      for (const m of half) {
        const inner = automergeMeta(cap)
        const commitBytes = inner.getChangeByHash(m.hash)
        const head = CommitId.fromHexString(m.hash)
        const parents = m.deps.map((d: string) => CommitId.fromHexString(d))
        await subduction.addCommit(sid, head, parents, commitBytes)
      }

      const heads1 = Automerge.getHeads(cap).join(",")
      headsObserved.push(`${label}-end:${heads1.slice(0, 8)}`)
    }

    await Promise.all([saveTask("A"), saveTask("B")])

    // eslint-disable-next-line no-console
    console.log(`headsAtStart=${headsAtStart.slice(0, 16)}`)
    for (const o of headsObserved) {
      // eslint-disable-next-line no-console
      console.log(`  ${o}`)
    }

    expect(
      headsObserved.every(o => o.endsWith(headsAtStart.slice(0, 8))),
    ).toBe(true)
  })
})
