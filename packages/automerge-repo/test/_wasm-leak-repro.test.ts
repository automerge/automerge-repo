/**
 * Minimal repro to test the hypothesis that Automerge.Doc<T> snapshots
 * leak read-side mutations: that calling `getChangeByHash` on a doc
 * shifts the value subsequently returned by `getHeads(doc)`.
 *
 * If this hypothesis is correct, we can't dedupe concurrent saves via
 * head identity. If it's wrong, we have more design space.
 *
 * Run with:
 *   RUN_PERF=1 pnpm exec vitest run --no-file-parallelism \
 *     --project @automerge/automerge-repo test/_wasm-leak-repro.test.ts
 */

import { next as Automerge } from "@automerge/automerge/slim"
import { beforeAll, describe, expect, test } from "vitest"

import { initSubduction } from "../src/initSubduction.js"
import { automergeMeta } from "../src/subduction/helpers.js"

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

maybeDescribe("automerge wasm doc-snapshot leak repro", () => {
  test("getHeads is stable under repeated identical reads", () => {
    const doc = buildDoc(100)
    const heads1 = Automerge.getHeads(doc).join(",")
    const heads2 = Automerge.getHeads(doc).join(",")
    const heads3 = Automerge.getHeads(doc).join(",")
    expect(heads2).toBe(heads1)
    expect(heads3).toBe(heads1)
  })

  test("getHeads is stable after getChangesMetaSince", () => {
    const doc = buildDoc(100)
    const heads1 = Automerge.getHeads(doc).join(",")
    Automerge.getChangesMetaSince(doc, [])
    const heads2 = Automerge.getHeads(doc).join(",")
    expect(heads2).toBe(heads1)
  })

  test("getHeads is stable after getChangeByHash", () => {
    const doc = buildDoc(100)
    const heads1 = Automerge.getHeads(doc).join(",")
    const meta = Automerge.getChangesMetaSince(doc, [])
    const inner = automergeMeta(doc)
    for (const m of meta) {
      inner.getChangeByHash(m.hash)
    }
    const heads2 = Automerge.getHeads(doc).join(",")
    expect(heads2).toBe(heads1)
  })

  test("getHeads on TWO doc references from same handle (no concurrent reads)", async () => {
    const doc1 = buildDoc(100)
    // simulate two captured references
    const docRef = doc1
    const heads1 = Automerge.getHeads(doc1).join(",")
    const heads1b = Automerge.getHeads(docRef).join(",")
    expect(heads1b).toBe(heads1)
  })

  // The key test: do CONCURRENT (well, microtask-interleaved) reads
  // of the same doc reference produce inconsistent heads? Note: JS is
  // single-threaded, so "concurrent" really means "interleaved across
  // awaits".
  test("getHeads on same doc across microtask boundaries", async () => {
    const doc = buildDoc(100)
    const heads0 = Automerge.getHeads(doc).join(",")

    const observations: string[] = []
    const reader = async () => {
      observations.push(Automerge.getHeads(doc).join(","))
      await Promise.resolve()
      observations.push(Automerge.getHeads(doc).join(","))
      // simulate doing wasm work between reads
      const meta = Automerge.getChangesMetaSince(doc, [])
      const inner = automergeMeta(doc)
      for (const m of meta.slice(0, 50)) {
        inner.getChangeByHash(m.hash)
      }
      observations.push(Automerge.getHeads(doc).join(","))
    }

    await Promise.all([reader(), reader(), reader()])

    // eslint-disable-next-line no-console
    console.log(`observations:`)
    for (const o of observations) {
      // eslint-disable-next-line no-console
      console.log(`  ${o.slice(0, 16)}`)
    }

    expect(observations.every(o => o === heads0)).toBe(true)
  })

  // What if changes are happening to a SEPARATE doc reference held by
  // the handle? Does our captured snapshot stay stable? This more
  // closely simulates the SubductionSource scenario.
  test("captured doc snapshot is stable when a 'sibling' doc evolves", () => {
    let live = buildDoc(100)
    const captured = live // same reference initially
    const headsAtCapture = Automerge.getHeads(captured).join(",")

    // Mutate the live doc — but Automerge.change returns a NEW doc
    // and assigns to live. The captured reference should NOT see new
    // changes...
    for (let i = 100; i < 200; i++) {
      live = Automerge.change(live, d => {
        d.count = i
      })
    }

    const headsAfter = Automerge.getHeads(captured).join(",")
    expect(headsAfter).toBe(headsAtCapture)
  })

  // And the smoking gun for SubductionSource: simulate two saves
  // capturing entry.handle.doc() at different times, with mutations
  // happening between them.
  test("two doc references captured at different times have stable distinct heads", () => {
    let live = buildDoc(100)
    const captured1 = live
    const heads1 = Automerge.getHeads(captured1).join(",")

    for (let i = 100; i < 200; i++) {
      live = Automerge.change(live, d => {
        d.count = i
      })
    }

    const captured2 = live
    const heads2 = Automerge.getHeads(captured2).join(",")

    // captured1 should still report old heads
    const heads1Reread = Automerge.getHeads(captured1).join(",")

    // eslint-disable-next-line no-console
    console.log(
      `heads1=${heads1.slice(0, 16)} heads1Reread=${heads1Reread.slice(0, 16)} heads2=${heads2.slice(0, 16)}`,
    )

    expect(heads1).not.toBe(heads2)
    expect(heads1Reread).toBe(heads1)
  })

  // The actual scenario: TWO captures of handle.doc() with
  // getChangeByHash work happening between the captures. The first
  // capture's heads should remain stable.
  test("captured1 stays stable while captured2 (later) is read with getChangeByHash", () => {
    let live = buildDoc(100)
    const captured1 = live
    const heads1Before = Automerge.getHeads(captured1).join(",")

    for (let i = 100; i < 200; i++) {
      live = Automerge.change(live, d => {
        d.count = i
      })
    }

    const captured2 = live
    const meta2 = Automerge.getChangesMetaSince(captured2, [])
    const inner2 = automergeMeta(captured2)
    for (const m of meta2.slice(0, 100)) {
      inner2.getChangeByHash(m.hash)
    }

    const heads1After = Automerge.getHeads(captured1).join(",")
    expect(heads1After).toBe(heads1Before)
  })

  // The scenario closest to SubductionSource: two captures from the
  // SAME live ref via separate variable assignments, with reads on
  // captured1 happening WHILE captured2 is also being read. (Note:
  // in real SubductionSource, the throttle captures handle.doc() at
  // call time. handle.doc() returns this.#doc, which is reassigned
  // by handle.change(). So the two saves capture the same #doc
  // reference if no change happened between fires, OR different
  // references if a change did happen.)
  test("two saves capture handle.doc() back-to-back with NO change between (concurrent reads)", async () => {
    let live = buildDoc(100)
    const headsAtBuild = Automerge.getHeads(live).join(",")

    // Two "captures" both of the same reference
    const cap1 = live
    const cap2 = live // same reference

    // Now do interleaved reads with getChangeByHash
    const meta = Automerge.getChangesMetaSince(cap1, [])
    const inner1 = automergeMeta(cap1)
    const inner2 = automergeMeta(cap2)

    const observations: { who: string; heads: string }[] = []

    const work = async (label: string, inner: any) => {
      observations.push({ who: `${label}-start`, heads: Automerge.getHeads(cap1).join(",") })
      for (const m of meta.slice(0, 50)) {
        inner.getChangeByHash(m.hash)
        await Promise.resolve()
      }
      observations.push({ who: `${label}-end`, heads: Automerge.getHeads(cap1).join(",") })
    }

    await Promise.all([work("A", inner1), work("B", inner2)])

    const finalHeads = Automerge.getHeads(cap1).join(",")
    // eslint-disable-next-line no-console
    console.log(`headsAtBuild=${headsAtBuild.slice(0, 16)} finalHeads=${finalHeads.slice(0, 16)}`)
    for (const o of observations) {
      // eslint-disable-next-line no-console
      console.log(`  ${o.who.padEnd(10)} ${o.heads.slice(0, 16)}`)
    }

    expect(finalHeads).toBe(headsAtBuild)
    // All observations should be the same
    expect(observations.every(o => o.heads === headsAtBuild)).toBe(true)
  })
})
