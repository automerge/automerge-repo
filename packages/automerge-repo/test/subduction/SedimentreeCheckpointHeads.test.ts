/**
 * Repro: `Subduction.getAllHeads()` advertises a stale loose commit as a head after an
 * incremental sync, so it disagrees with the materialized automerge document.
 *
 * A receiver that synced loose commits before the fragment formed holds loose commits 1..N-1
 * plus a fragment whose head N is not itself a loose commit. That is the normal incremental
 * path: `SubductionSource` sends each record once, as it appears, and an accept-only peer never
 * deletes. Sedimentree's loose-commit DAG then sees no successor for N-1 and advertises it as a
 * head beside N, while automerge, reading the whole change graph, knows N-1 is interior.
 *
 * Every value fed to Subduction below comes from `Automerge.getFragmentMetadata` and
 * `Automerge.bundleFragmentMetadata` — the same calls `SubductionSource` makes in
 * `src/subduction/source.ts`, passed through unmodified. The only thing this test chooses is
 * WHEN it looks: one snapshot before the fragment-forming change and one after, exactly as an
 * incremental sync would.
 *
 * Consequence: a peer advertising sedimentree heads permanently disagrees with a peer
 * advertising materialized automerge heads although both hold identical bytes, so collection
 * sync reports a differing document forever.
 *
 * History: up to `@automerge/automerge` 3.4.x the same tree produced the opposite failure —
 * `getFragmentMetadata` listed the fragment's own head among its checkpoints, sedimentree's head
 * filter erased the fragment, and only the stale loose tip was advertised
 * (inkandswitch/subduction#301). 3.5.0 stopped emitting the self-checkpoint; the BUG test below
 * asserts that precondition so a downgrade fails for the right reason. Fragments already in
 * storage still carry it.
 */
import { next as A } from "@automerge/automerge"
import * as Automerge from "@automerge/automerge"
import {
  BlobMeta,
  CommitId,
  CommitInput,
  Fragment,
  FragmentInput,
  LooseCommit,
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

const commitIdOf = (hash: string): CommitId =>
  CommitId.fromBytes(Uint8Array.from(Buffer.from(hash, "hex")))

const treeId = (): SedimentreeId =>
  SedimentreeId.fromBytes(new Uint8Array(32).fill(7))

/**
 * Appends changes until one hashes with a `00` prefix, i.e. is a level>=1 commit that automerge
 * packs as a fragment head. Stopping at the first such hash makes the shape deterministic: the
 * `after` snapshot holds exactly one fragment covering every change, and `before` — taken just
 * prior to that change — holds only loose commits, the last of which is `looseTip`.
 */
const buildDocument = () => {
  let doc = A.init<{ value?: number }>()
  let before = doc
  let count = 0
  let lastHash = ""
  do {
    before = A.clone(doc)
    doc = A.change(doc, mutable => {
      mutable.value = count++
    })
    const bytes = A.getLastLocalChange(doc)
    if (!bytes) throw new Error("no change produced")
    lastHash = A.decodeChange(bytes).hash
  } while (!lastHash.startsWith("00"))
  const [looseTip] = A.getHeads(before)
  return { before, after: doc, looseTip }
}

/** The metadata `SubductionSource` builds its records from. */
const metadataOf = (doc: A.Doc<unknown>) => ({
  commitMetas: automerge.getFragmentMetadata(doc, 0),
  fragmentMetas: automerge.getFragmentMetadata(doc, { start: 1 }),
})

/**
 * Replays the snapshots into one Subduction the way `SubductionSource` streams a live document:
 * each snapshot contributes only the records not already sent, bundled from that snapshot. With
 * `alsoLoose`, that document's newest change is additionally stored as a loose commit (its own
 * hash, deps and bytes, all from automerge). Returns the heads Subduction then advertises.
 */
const advertisedHeads = async (
  snapshots: A.Doc<unknown>[],
  { alsoLoose }: { alsoLoose?: A.Doc<unknown> } = {}
): Promise<string[]> => {
  const id = treeId()
  const subduction = new Subduction({
    signer: await MemorySigner.generate(),
    storage: new MemoryStorage(),
  })

  const known = new Set<string>()
  for (const doc of snapshots) {
    const { commitMetas, fragmentMetas } = metadataOf(doc)
    const newCommits = commitMetas.filter(meta => !known.has(meta.head))
    const newFragments = fragmentMetas.filter(meta => !known.has(meta.head))

    if (newCommits.length > 0) {
      const blobs = automerge.bundleFragmentMetadata(doc, newCommits)
      await subduction.addCommitsBatch(
        id,
        newCommits.map(
          (meta, index) =>
            new CommitInput(
              new LooseCommit(
                id,
                commitIdOf(meta.head),
                meta.boundary.map(commitIdOf),
                new BlobMeta(blobs[index])
              ),
              blobs[index]
            )
        )
      )
    }
    if (newFragments.length > 0) {
      const blobs = automerge.bundleFragmentMetadata(doc, newFragments)
      await subduction.addFragmentsBatch(
        id,
        newFragments.map(
          (meta, index) =>
            new FragmentInput(
              new Fragment(
                id,
                commitIdOf(meta.head),
                meta.boundary.map(commitIdOf),
                meta.checkpoints.map(commitIdOf),
                new BlobMeta(blobs[index])
              ),
              blobs[index]
            )
        )
      )
    }
    for (const meta of [...newCommits, ...newFragments]) known.add(meta.head)
  }

  if (alsoLoose) {
    const bytes = A.getLastLocalChange(alsoLoose)
    if (!bytes) throw new Error("no local change to store loose")
    const { hash, deps } = A.decodeChange(bytes)
    await subduction.addCommitsBatch(id, [
      new CommitInput(
        new LooseCommit(
          id,
          commitIdOf(hash),
          deps.map(commitIdOf),
          new BlobMeta(bytes)
        ),
        bytes
      ),
    ])
  }

  const all = await subduction.getAllHeads()
  const entry = all.find(candidate => candidate.id.toString() === id.toString())
  return (entry?.heads ?? []).map(head => head.toHexString()).sort()
}

describe("Subduction.getAllHeads over automerge-emitted records", () => {
  it("control: a single snapshot advertises exactly the document head", async () => {
    const { after } = buildDocument()

    // Once the fragment forms, level 0 is empty — there is no loose commit left to go stale.
    expect(metadataOf(after).commitMetas).toHaveLength(0)
    expect(await advertisedHeads([after])).toEqual(A.getHeads(after))
  })

  it("BUG: loose commits synced before the fragment formed linger as heads", async () => {
    const { before, after, looseTip } = buildDocument()
    const [documentHead] = A.getHeads(after)

    // Precondition (automerge >= 3.5.0): the fragment must not list its own head as a checkpoint,
    // or sedimentree erases the fragment and this test would see {N-1} for the older reason.
    const { fragmentMetas } = metadataOf(after)
    expect(fragmentMetas).toHaveLength(1)
    expect(fragmentMetas[0].checkpoints).not.toContain(fragmentMetas[0].head)

    // What an incremental receiver accumulates: N-1 loose commits, then one fragment. The
    // document has a single head, but Subduction also advertises the absorbed loose tip.
    expect(await advertisedHeads([before, after])).toEqual(
      [documentHead, looseTip].sort()
    )
  })

  it("control: the extra head disappears once the loose DAG can see the successor", async () => {
    const { before, after } = buildDocument()

    // Same records plus change N stored loose as well: N-1 now has a loose successor, so only the
    // fragment head survives. The missing edge is in the loose-commit DAG, not in storage.
    expect(
      await advertisedHeads([before, after], { alsoLoose: after })
    ).toEqual(A.getHeads(after))
  })
})
