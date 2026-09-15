/**
 * Repro: a fragment that lists its own head among its checkpoints erases itself from
 * `Subduction.getAllHeads()`.
 *
 * Introduced by the `heads_assuming_minimal` rewrite in sedimentree_core 0.14.2
 * (`@automerge/automerge-subduction` 0.17.2), which fixed inkandswitch/subduction#286.
 * The new rule is:
 *
 *   heads = every fragment head and loose commit NOT referenced as a commit parent,
 *           a fragment boundary, or a fragment checkpoint
 *
 * The checkpoint exclusion has no exception for the fragment's own head.
 *
 * Every value fed to Subduction below comes from `Automerge.getFragmentMetadata` and
 * `Automerge.bundleFragmentMetadata` — the same calls `SubductionSource` makes in
 * `src/subduction/source.ts`, which passes `meta.checkpoints` through unmodified. Nothing
 * here is hand-constructed, so the input is what the production path actually produces.
 *
 * Consequence: a peer that advertises sedimentree heads permanently disagrees with a peer
 * that advertises materialized automerge heads, even though both hold identical bytes —
 * collection sync then reports a differing document forever. Tracked as
 * inkandswitch/subduction#301.
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

const commitIdOf = (hash: string): CommitId =>
  CommitId.fromBytes(Uint8Array.from(Buffer.from(hash, "hex")))

const treeId = (): SedimentreeId =>
  SedimentreeId.fromBytes(new Uint8Array(32).fill(7))

/**
 * Builds a document whose newest change is itself a level>=1 commit (hash prefixed `00`), so
 * automerge packs it as a fragment head. This is the production shape: the change that IS the
 * document head lives inside a fragment.
 */
const buildDocument = () => {
  let doc = A.init<{ value?: number }>()
  let count = 0
  let lastHash = ""
  do {
    doc = A.change(doc, mutable => {
      mutable.value = count++
    })
    const bytes = A.getLastLocalChange(doc)
    if (!bytes) throw new Error("no change produced")
    lastHash = A.decodeChange(bytes).hash
  } while (!lastHash.startsWith("00"))
  return doc
}

/** The metadata `SubductionSource` builds its records from. */
const metadataOf = (doc: A.Doc<unknown>) => {
  const automerge = Automerge as unknown as {
    getFragmentMetadata: (doc: unknown, level: unknown) => FragmentMeta[]
    bundleFragmentMetadata: (
      doc: unknown,
      metas: FragmentMeta[]
    ) => Uint8Array[]
  }
  const commitMetas = automerge.getFragmentMetadata(doc, 0)
  const fragmentMetas = automerge.getFragmentMetadata(doc, { start: 1 })
  return {
    commitMetas,
    commitBlobs: commitMetas.length
      ? automerge.bundleFragmentMetadata(doc, commitMetas)
      : [],
    fragmentMetas,
    fragmentBlobs: automerge.bundleFragmentMetadata(doc, fragmentMetas),
  }
}

/**
 * Replays the metadata into a Subduction exactly as `SubductionSource` does and returns the
 * heads it advertises. `checkpoints` is the only thing a caller can vary.
 */
const advertisedHeads = async (
  doc: A.Doc<unknown>,
  { stripCheckpoints = false }: { stripCheckpoints?: boolean } = {}
): Promise<string[]> => {
  const { commitMetas, commitBlobs, fragmentMetas, fragmentBlobs } =
    metadataOf(doc)
  const id = treeId()
  const subduction = new Subduction({
    signer: await MemorySigner.generate(),
    storage: new MemoryStorage(),
  })

  if (commitMetas.length > 0) {
    await subduction.addCommitsBatch(
      id,
      commitMetas.map(
        (meta, index) =>
          new CommitInput(
            new LooseCommit(
              id,
              commitIdOf(meta.head),
              meta.boundary.map(commitIdOf),
              new BlobMeta(commitBlobs[index])
            ),
            commitBlobs[index]
          )
      )
    )
  }

  await subduction.addFragmentsBatch(
    id,
    fragmentMetas.map(
      (meta, index) =>
        new FragmentInput(
          new Fragment(
            id,
            commitIdOf(meta.head),
            meta.boundary.map(commitIdOf),
            (stripCheckpoints ? [] : meta.checkpoints).map(commitIdOf),
            new BlobMeta(fragmentBlobs[index])
          ),
          fragmentBlobs[index]
        )
    )
  )

  const all = await subduction.getAllHeads()
  const entry = all.find(candidate => candidate.id.toString() === id.toString())
  return (entry?.heads ?? []).map(head => head.toHexString()).sort()
}

describe("Subduction.getAllHeads over automerge-emitted fragments", () => {
  it("automerge lists every fragment's own head among its checkpoints", () => {
    const doc = buildDocument()
    const { fragmentMetas } = metadataOf(doc)
    expect(fragmentMetas.length).toBeGreaterThan(0)

    // Not a property this test chose — it is what getFragmentMetadata returns.
    const selfCheckpointed = fragmentMetas.filter(meta =>
      meta.checkpoints.includes(meta.head)
    )
    expect(selfCheckpointed).toHaveLength(fragmentMetas.length)
  })

  it("BUG: a tree built from that metadata advertises no heads at all", async () => {
    const doc = buildDocument()
    // The document has content and a well-defined head.
    expect(A.getHeads(doc)).toHaveLength(1)

    // Every fragment erases itself via its own checkpoint, leaving nothing to advertise.
    expect(await advertisedHeads(doc)).toEqual([])
  })

  it("control: dropping only the checkpoints restores the document head", async () => {
    const doc = buildDocument()
    // Same records, same heads, same boundaries, same blobs — checkpoints alone removed.
    expect(await advertisedHeads(doc, { stripCheckpoints: true })).toEqual(
      A.getHeads(doc)
    )
  })
})
