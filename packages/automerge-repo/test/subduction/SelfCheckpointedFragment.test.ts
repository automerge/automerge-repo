/**
 * Repro: a fragment that lists its own head among its checkpoints erases that head from
 * `Subduction.getAllHeads()`, and a peer that holds such a fragment keeps it: sync never hands it
 * a copy without the self-checkpoint.
 *
 * Automerge before 3.5 put every fragment's own head into `checkpoints` (this branch still pins
 * 3.3.2), and `SubductionSource` stores them unchanged, so every fragment such a client wrote has
 * this shape. `Sedimentree::heads_assuming_minimal` drops every id listed among any fragment's
 * checkpoints, the fragment's own head included. A document whose newest change is the head of
 * such a fragment is therefore advertised with no heads by every peer that holds the fragment,
 * while automerge reports that head, so collection sync never converges on it.
 *
 * automerge/automerge#1559 (automerge 3.5) stopped emitting the self-checkpoint, which covers new
 * fragments only. Stored ones stay: sync fingerprints fragments by head, so a peer that already
 * holds a fragment for a head is never sent another fragment for that head.
 *
 * Every record below comes from `Automerge.getFragmentMetadata` and
 * `Automerge.bundleFragmentMetadata`. The only thing the tests choose is the checkpoint list:
 * `[head]`, as automerge before 3.5 emitted it, or `[]`, as 3.5 does.
 *
 * Tracked in inkandswitch/subduction#306.
 */
import { next as A } from "@automerge/automerge"
import * as Automerge from "@automerge/automerge"
import {
  BlobMeta,
  CommitId,
  Fragment,
  FragmentInput,
  MemorySigner,
  MemoryStorage,
  SedimentreeId,
  Subduction,
} from "@automerge/automerge-subduction"
import { beforeAll, describe, expect, it } from "vitest"

import { initSubduction } from "../../src/initSubduction.js"

beforeAll(async () => {
  await initSubduction()
})

type FragmentMeta = {
  head: string
  level: number
  boundary: string[]
  checkpoints: string[]
}

const automerge = Automerge as unknown as {
  getFragmentMetadata: (doc: unknown, level: unknown) => FragmentMeta[]
  bundleFragmentMetadata: (doc: unknown, metas: FragmentMeta[]) => Uint8Array[]
}

const id = SedimentreeId.fromBytes(new Uint8Array(32).fill(7))

/**
 * Appends changes until one hashes with a `00` prefix, i.e. is a level>=1 commit. Stopping at the
 * first such hash leaves exactly one fragment covering every change and no loose commits: the
 * document's only head is the fragment's head.
 */
const buildDocument = () => {
  let doc = A.init<{ value?: number }>()
  let count = 0
  do {
    doc = A.change(doc, mutable => {
      mutable.value = count++
    })
  } while (!A.getHeads(doc)[0].startsWith("00"))
  return doc
}

/** The document's single fragment, with or without its own head among its checkpoints. */
const fragmentOf = (doc: A.Doc<unknown>, checkpoints: "self" | "none") => {
  expect(automerge.getFragmentMetadata(doc, 0)).toHaveLength(0)
  const metas = automerge.getFragmentMetadata(doc, { start: 1 })
  expect(metas).toHaveLength(1)
  const [blob] = automerge.bundleFragmentMetadata(doc, metas)
  const head = CommitId.fromHexString(metas[0].head)
  return new FragmentInput(
    new Fragment(
      id,
      head,
      metas[0].boundary.map(b => CommitId.fromHexString(b)),
      checkpoints === "self" ? [head] : [],
      new BlobMeta(blob)
    ),
    blob
  )
}

const peerHolding = async (
  doc: A.Doc<unknown>,
  checkpoints: "self" | "none"
) => {
  const subduction = new Subduction({
    signer: await MemorySigner.generate(),
    storage: new MemoryStorage(),
  })
  await subduction.storeBuiltBatch(id, [], [fragmentOf(doc, checkpoints)])
  return subduction
}

const emptyPeer = async () =>
  new Subduction({
    signer: await MemorySigner.generate(),
    storage: new MemoryStorage(),
  })

const advertisedHeads = async (subduction: Subduction) => {
  const [tree] = await subduction.getAllHeads()
  return tree?.heads.map(head => head.toHexString())
}

/** An inbound fragment is stored after the sender's round has settled. */
const untilStored = async (subduction: Subduction) => {
  for (let attempt = 0; attempt < 50; attempt++) {
    if ((await subduction.getFragments(id))?.length) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error("fragment was never stored")
}

describe("a fragment that lists its own head among its checkpoints", () => {
  it("control: without the self-checkpoint, the document head is advertised", async () => {
    const doc = buildDocument()
    const peer = await peerHolding(doc, "none")

    expect(await advertisedHeads(peer)).toEqual(A.getHeads(doc))
  })

  it("BUG: with the self-checkpoint, the document is advertised with no heads", async () => {
    const doc = buildDocument()
    const peer = await peerHolding(doc, "self")

    // Same record apart from the checkpoint list; automerge still sees one head.
    expect(A.getHeads(doc)).toHaveLength(1)
    expect(await advertisedHeads(peer)).toEqual([])
  })

  it("control: a peer without the fragment takes it over sync and advertises the head", async () => {
    const doc = buildDocument()
    const source = await peerHolding(doc, "none")
    const target = await emptyPeer()
    await Subduction.link(source, target)

    await source.syncWithAllPeers(id, true, 5_000)
    await untilStored(target)

    expect(await advertisedHeads(target)).toEqual(A.getHeads(doc))
  })

  it("BUG: a peer that holds the self-checkpointed fragment is never sent the other copy", async () => {
    const doc = buildDocument()
    const source = await peerHolding(doc, "none")
    const target = await peerHolding(doc, "self")
    await Subduction.link(source, target)

    const [round] = (await source.syncWithAllPeers(id, true, 5_000)).entries()

    // The round succeeds and moves nothing: both peers hold a fragment for that head.
    expect(round.success).toBe(true)
    expect(round.stats.totalSent).toBe(0)
    expect(round.stats.totalReceived).toBe(0)
    // So the two peers disagree about the same document for good: the target keeps advertising
    // no heads, and that is what the source hears from it.
    expect(round.stats.remoteHeads.map(head => head.toHexString())).toEqual([])
    expect(await advertisedHeads(target)).toEqual([])
    expect(await advertisedHeads(source)).toEqual(A.getHeads(doc))
  })
})
