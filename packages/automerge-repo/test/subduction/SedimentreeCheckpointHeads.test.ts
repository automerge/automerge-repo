/**
 * Repro: a fragment that lists its own head among its checkpoints erases itself from
 * `Subduction.getAllHeads()`, so the tree is advertised at a stale ancestor forever.
 *
 * Introduced by the `heads_assuming_minimal` rewrite in sedimentree_core 0.14.2
 * (`@automerge/automerge-subduction` 0.17.2), which fixed
 * inkandswitch/subduction#286. The new rule is:
 *
 *   heads = every fragment head and loose commit NOT referenced as a commit parent,
 *           a fragment boundary, or a fragment checkpoint
 *
 * The checkpoint exclusion has no exception for the fragment's own head. A fragment whose
 * checkpoint set contains its head therefore removes itself from the candidate heads, and a
 * tree whose newest change lives in that fragment is advertised at the pre-fragment loose tip.
 *
 * Isolated below by holding one tree constant and varying only the checkpoint list:
 *
 *   checkpoints = []          -> {fragment head, loose tip}   head present, stale tip lingers
 *   checkpoints = [own head]  -> {loose tip}                  head erased           <-- bug
 *   checkpoints = [loose tip] -> {fragment head}              correct
 *
 * Why it matters: a peer that advertises sedimentree heads (the DXOS edge service) permanently
 * disagrees with a peer that advertises materialized automerge heads, even though both hold
 * identical bytes — collection sync reports one differing document forever. This is the same
 * production symptom as #286 (document advertised at `072349b1…` while holding `00cd93ac…`),
 * which bumping to 0.17.2 did NOT resolve: the cause moved from the boundary mix-up to this
 * checkpoint self-reference.
 *
 * `it.fails` marks the property a fix must restore. The other assertions pin current behavior
 * and will fail if it changes.
 *
 * Companion: #741 documents the pre-0.17.2 boundary bug and is asserted against 0.16.1; on the
 * bumped pin in this PR its expectations need regrading.
 */
import { next as A } from "@automerge/automerge"
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

/** One automerge change: bytes, hash (== subduction CommitId), and parent hashes. */
type ChangeRecord = { bytes: Uint8Array; hash: string; parents: string[] }

/**
 * Appends changes until one hash starts with `00` — 8 leading zero bits, i.e. a depth >= 1
 * commit, which is what a real fragment head always is. The earlier changes stay loose.
 */
const buildChainEndingInFragmentHead = (): ChangeRecord[] => {
  let doc = A.init<{ value?: number }>()
  const changes: ChangeRecord[] = []
  let counter = 0

  for (let attempts = 0; ; attempts++) {
    if (attempts > 20_000)
      throw new Error("failed to mine a 00-prefixed change hash")
    doc = A.change(doc, mutable => {
      mutable.value = counter++
    })
    const bytes = A.getLastLocalChange(doc)
    if (!bytes) throw new Error("no change produced")
    const decoded = A.decodeChange(bytes)
    changes.push({ bytes, hash: decoded.hash, parents: [...decoded.deps] })
    if (decoded.hash.startsWith("00")) return changes
  }
}

const hexToBytes = (hex: string): Uint8Array => {
  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

const commitIdOf = (hash: string): CommitId =>
  CommitId.fromBytes(hexToBytes(hash))

const concat = (chunks: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(
    chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  )
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

const materializedHeads = (blobs: Uint8Array[]): string[] => {
  const doc = A.load(concat(blobs))
  try {
    return [...A.getHeads(doc)].sort()
  } finally {
    A.free(doc)
  }
}

const headsFor = async (
  subduction: Subduction,
  treeId: SedimentreeId
): Promise<string[]> => {
  const allHeads = await subduction.getAllHeads()
  const entry = allHeads.find(
    candidate => candidate.id.toString() === treeId.toString()
  )
  return (entry?.heads ?? []).map(head => head.toHexString()).sort()
}

describe("Subduction.getAllHeads with fragment checkpoints", () => {
  /**
   * One tree, three checkpoint lists. Every older change is also stored as a loose commit and
   * the newest change lives only inside a boundary-less fragment — the production shape.
   *
   * `checkpoints` is the ONLY thing that varies between runs.
   */
  const buildTree = async (
    pickCheckpoints: (heads: {
      fragmentHead: string
      looseTip: string
    }) => string[]
  ) => {
    const changes = buildChainEndingInFragmentHead()
    const fragmentHead = changes[changes.length - 1]
    const loose = changes.slice(0, -1)
    expect(loose.length).toBeGreaterThan(0)
    const looseTip = loose[loose.length - 1]

    const treeId = SedimentreeId.fromBytes(new Uint8Array(32).fill(7))
    const subduction = new Subduction({
      signer: await MemorySigner.generate(),
      storage: new MemoryStorage(),
    })

    await subduction.addCommitsBatch(
      treeId,
      loose.map(
        change =>
          new CommitInput(
            new LooseCommit(
              treeId,
              commitIdOf(change.hash),
              change.parents.map(commitIdOf),
              new BlobMeta(change.bytes)
            ),
            change.bytes
          )
      )
    )

    const fragmentBlob = concat(changes.map(change => change.bytes))
    const checkpoints = pickCheckpoints({
      fragmentHead: fragmentHead.hash,
      looseTip: looseTip.hash,
    })
    await subduction.addFragmentsBatch(treeId, [
      new FragmentInput(
        new Fragment(
          treeId,
          commitIdOf(fragmentHead.hash),
          [],
          checkpoints.map(commitIdOf),
          new BlobMeta(fragmentBlob)
        ),
        fragmentBlob
      ),
    ])

    // The tree's true heads: exactly the fragment head, on every variant.
    expect(
      materializedHeads([...loose.map(change => change.bytes), fragmentBlob])
    ).toEqual([fragmentHead.hash])

    return {
      heads: await headsFor(subduction, treeId),
      fragmentHead: fragmentHead.hash,
      looseTip: looseTip.hash,
    }
  }

  it("BUG: a fragment listing its own head as a checkpoint erases itself from the head set", async () => {
    const { heads, looseTip } = await buildTree(({ fragmentHead }) => [
      fragmentHead,
    ])
    // Only the stale ancestor is advertised; the change that IS the document head is gone.
    expect(heads).toEqual([looseTip])
  })

  it.fails("a self-checkpointed fragment still advertises its head", async () => {
    const { heads, fragmentHead } = await buildTree(
      ({ fragmentHead: head }) => [head]
    )
    expect(heads).toContain(fragmentHead)
  })

  it("control: with no checkpoints the fragment head is advertised", async () => {
    const { heads, fragmentHead, looseTip } = await buildTree(() => [])
    // Note the absorbed loose tip still lingers here — a separate, pre-existing residual:
    // `CommitDag::simplify` cannot attribute loose commits to a fragment whose head is not a
    // loose DAG node, so they survive minimization.
    expect(heads).toEqual([fragmentHead, looseTip].sort())
  })

  it("control: checkpointing the covered tip instead yields exactly the materialized heads", async () => {
    const { heads, fragmentHead } = await buildTree(({ looseTip }) => [
      looseTip,
    ])
    expect(heads).toEqual([fragmentHead])
  })
})
