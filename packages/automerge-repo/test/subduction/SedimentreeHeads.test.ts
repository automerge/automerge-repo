/**
 * Repro: `Subduction.getAllHeads()` mis-reports the heads of any sedimentree
 * that contains fragments.
 *
 * Observed behavior (verified here synthetically, and against three
 * fragment-bearing trees from a production DXOS profile):
 *
 *   getAllHeads() = (tips of the loose-commit DAG)
 *                 ∪ (every fragment's BOUNDARY ids)
 *   — fragment HEADS are never included.
 *
 * The cause is in `sedimentree_core::Sedimentree::heads_assuming_minimal`
 * (sedimentree_core/src/sedimentree.rs): the fragment loop does
 * `heads.extend(fragment.boundary())` where its own doc comment ("the heads
 * … are the END hashes of all strata …") calls for the fragment's HEAD. A
 * boundary is by definition the covered start of a stratum, so advertising it
 * is never correct; and a fragment whose newest change is the document head
 * contributes nothing at all when its boundary is empty.
 *
 * Downstream effect (how this was found): a peer that advertises sedimentree
 * heads (e.g. the DXOS edge service) permanently disagrees with a peer that
 * advertises materialized automerge heads, even when both hold identical
 * bytes — collection sync reports one differing document forever. Production
 * incident: a document whose newest change lived in a single boundary-less
 * fragment (client head `00cd93ac…`) was advertised at the pre-fragment
 * loose tip (`072349b1…`) for 70+ minutes across reconnects.
 *
 * Test structure — three graded properties per shape:
 *   1. "BUG:" tests pin today's wrong output exactly (they PASS while the bug
 *      exists, and fail on any behavior change).
 *   2. `it.fails` twins assert the properties a fix must restore, from weak
 *      (no boundaries advertised / newest fragment head advertised — restored
 *      by swapping boundary→head in `heads_assuming_minimal`) to strong
 *      (equality with the materialized document heads — additionally requires
 *      accounting for loose commits and fragment heads whose coverage is only
 *      visible inside fragment blobs; see the notes on each test).
 * When the WASM is fixed, the corresponding tests flip: delete the "BUG:"
 * pins and drop the `.fails` markers.
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

/** One automerge change: bytes, hash (== subduction CommitId), parent hashes. */
type ChangeRecord = { bytes: Uint8Array; hash: string; parents: string[] }

/**
 * Builds a linear automerge change chain. Each "mined" position appends
 * changes until one's hash starts with `00` — 8 leading zero bits, i.e. a
 * depth >= 1 commit, the kind that becomes a fragment head/boundary. The
 * `plainTail` changes appended afterwards stay loose.
 */
const buildChain = (
  plainTail: number,
  minedZeroPrefixes: number
): { changes: ChangeRecord[]; mined: number[] } => {
  let doc = A.init<{ value?: number }>()
  const changes: ChangeRecord[] = []
  const mined: number[] = []
  let counter = 0

  const appendChange = (): ChangeRecord => {
    doc = A.change(doc, mutable => {
      mutable.value = counter++
    })
    const bytes = A.getLastLocalChange(doc)
    if (!bytes) throw new Error("no change produced")
    const decoded = A.decodeChange(bytes)
    const record: ChangeRecord = {
      bytes,
      hash: decoded.hash,
      parents: [...decoded.deps],
    }
    changes.push(record)
    return record
  }

  for (let index = 0; index < minedZeroPrefixes; index++) {
    for (let attempts = 0; ; attempts++) {
      if (attempts > 20_000)
        throw new Error("failed to mine a 00-prefixed change hash")
      if (appendChange().hash.startsWith("00")) break
    }
    mined.push(changes.length - 1)
  }
  for (let index = 0; index < plainTail; index++) appendChange()
  return { changes, mined }
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

const makeSedimentreeId = (): SedimentreeId => {
  const bytes = new Uint8Array(32)
  bytes[0] = 42
  return SedimentreeId.fromBytes(bytes)
}

const looseInput = (change: ChangeRecord, treeId: SedimentreeId): CommitInput =>
  new CommitInput(
    new LooseCommit(
      treeId,
      commitIdOf(change.hash),
      change.parents.map(commitIdOf),
      new BlobMeta(change.bytes)
    ),
    change.bytes
  )

const fragmentInput = (
  treeId: SedimentreeId,
  head: string,
  boundary: string[],
  blob: Uint8Array
): FragmentInput =>
  new FragmentInput(
    new Fragment(
      treeId,
      commitIdOf(head),
      boundary.map(commitIdOf),
      [],
      new BlobMeta(blob)
    ),
    blob
  )

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

const createSubduction = async (): Promise<Subduction> =>
  new Subduction({
    signer: await MemorySigner.generate(),
    storage: new MemoryStorage(),
  })

describe("Subduction.getAllHeads over fragment-bearing sedimentrees", () => {
  /**
   * Incident shape: the newest change lives in a fragment covering the whole
   * history (boundary=[]), with every older change also present as a loose
   * commit. `heads_assuming_minimal` skips the fragment's head and extends
   * its (empty) boundary, so the fragment contributes nothing and only the
   * loose tip — a strict ancestor of the real head — is advertised.
   */
  const incidentShape = async () => {
    const { changes } = buildChain(0, 1)
    // The mined 00-change is last: it becomes the fragment head; everything
    // else stays loose. Mirrors the production tree: 8 loose commits plus one
    // boundary-less fragment whose head is the only carrier of change 9.
    const fragmentHead = changes[changes.length - 1]
    const loose = changes.slice(0, -1)
    expect(loose.length).toBeGreaterThan(0)

    const treeId = makeSedimentreeId()
    const subduction = await createSubduction()
    await subduction.addCommitsBatch(
      treeId,
      loose.map(change => looseInput(change, treeId))
    )
    const fragmentBlob = concat(changes.map(change => change.bytes))
    await subduction.addFragmentsBatch(treeId, [
      fragmentInput(treeId, fragmentHead.hash, [], fragmentBlob),
    ])

    const truth = materializedHeads([
      ...loose.map(change => change.bytes),
      fragmentBlob,
    ])
    expect(truth).toEqual([fragmentHead.hash])
    return {
      subduction,
      treeId,
      fragmentHead: fragmentHead.hash,
      looseTip: loose[loose.length - 1].hash,
    }
  }

  it("BUG: advertises the loose tip instead of the covering fragment's head", async () => {
    const { subduction, treeId, looseTip } = await incidentShape()
    expect(await headsFor(subduction, treeId)).toEqual([looseTip])
  })

  // Restored by swapping boundary→head in `heads_assuming_minimal`.
  it.fails("advertised heads include the fragment head carrying the newest change", async () => {
    const { subduction, treeId, fragmentHead } = await incidentShape()
    expect(await headsFor(subduction, treeId)).toContain(fragmentHead)
  })

  // Stronger: also requires dropping the loose tip the fragment covers. The
  // loose range walk cannot attribute the loose commits to the fragment's
  // range (the fragment head is not a loose DAG node), so minimize keeps them
  // and their tip lingers in the head set even after the boundary→head fix.
  it.fails("advertised heads equal the materialized document heads (incident shape)", async () => {
    const { subduction, treeId, fragmentHead } = await incidentShape()
    expect(await headsFor(subduction, treeId)).toEqual([fragmentHead])
  })

  /**
   * Chained-fragment shape: two fragments where the second's boundary names
   * the first's head, and loose commits continue above the second fragment
   * (the state after normal absorption). The qualifying newest fragment
   * extends its BOUNDARY into the head set — phantom heads for ids that are
   * covered by definition.
   */
  const chainedShape = async () => {
    const { changes, mined } = buildChain(2, 2)
    const [firstFragmentEnd, secondFragmentEnd] = mined
    const fragmentA = changes[firstFragmentEnd]
    const fragmentB = changes[secondFragmentEnd]
    const loose = changes.slice(secondFragmentEnd + 1)
    expect(loose.length).toBeGreaterThanOrEqual(2)

    const treeId = makeSedimentreeId()
    const subduction = await createSubduction()
    await subduction.addCommitsBatch(
      treeId,
      loose.map(change => looseInput(change, treeId))
    )
    const blobA = concat(
      changes.slice(0, firstFragmentEnd + 1).map(change => change.bytes)
    )
    const blobB = concat(
      changes
        .slice(firstFragmentEnd + 1, secondFragmentEnd + 1)
        .map(change => change.bytes)
    )
    await subduction.addFragmentsBatch(treeId, [
      fragmentInput(treeId, fragmentA.hash, [], blobA),
      fragmentInput(treeId, fragmentB.hash, [fragmentA.hash], blobB),
    ])

    const tip = changes[changes.length - 1].hash
    const truth = materializedHeads([
      blobA,
      blobB,
      ...loose.map(change => change.bytes),
    ])
    expect(truth).toEqual([tip])
    return { subduction, treeId, tip, boundaryId: fragmentA.hash }
  }

  it("BUG: advertises a chained fragment's boundary id as a phantom head", async () => {
    const { subduction, treeId, tip, boundaryId } = await chainedShape()
    expect(await headsFor(subduction, treeId)).toEqual([boundaryId, tip].sort())
  })

  // Restored by swapping boundary→head in `heads_assuming_minimal`.
  it.fails("advertised heads contain no fragment boundary ids", async () => {
    const { subduction, treeId, boundaryId } = await chainedShape()
    expect(await headsFor(subduction, treeId)).not.toContain(boundaryId)
  })

  // Stronger: fragment B's head is the parent of the first loose commit, so
  // a correct head set must also exclude it as covered — coverage that is
  // only visible through the loose DAG's parent links, not the fragment
  // metadata alone.
  it.fails("advertised heads equal the materialized document heads (chained shape)", async () => {
    const { subduction, treeId, tip } = await chainedShape()
    expect(await headsFor(subduction, treeId)).toEqual([tip])
  })
})
