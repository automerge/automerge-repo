import {
  checkpointForCommit,
  checkpointId,
  commitId,
  type CheckpointId,
  type CommitId,
} from "./ids.js"

export interface LooseCommitRecord {
  readonly kind: "commit"
  readonly id: CommitId
  readonly parents: readonly CommitId[]
  readonly blob: Uint8Array
}

export interface FragmentRecord {
  readonly kind: "fragment"
  readonly head: CommitId
  readonly boundary: readonly CommitId[]
  readonly checkpoints: readonly CheckpointId[]
  readonly blob: Uint8Array
}

export type SedimentreeRecord = LooseCommitRecord | FragmentRecord
export type RecordBatch = readonly SedimentreeRecord[]

export function recordHead(record: SedimentreeRecord): CommitId {
  return record.kind === "commit" ? record.id : record.head
}

/** Record metadata that decides fragment coverage. */
export type CoverageItem =
  | Pick<LooseCommitRecord, "kind" | "id">
  | Pick<FragmentRecord, "kind" | "head" | "checkpoints">

/**
 * Boundary commits among `items` that no fragment among them covers, as head
 * or checkpoint. Stateless: coverage outside `items` is not known, so a
 * consumer may also be told of heads a fragment it saw earlier covers.
 */
export function fragmentRequests(
  items: Iterable<CoverageItem>,
  isBoundary: (id: CommitId) => boolean
): CommitId[] {
  const boundaries = new Set<CommitId>()
  const heads = new Set<CommitId>()
  const checkpoints = new Set<CheckpointId>()
  for (const item of items) {
    if (item.kind === "commit") {
      if (isBoundary(item.id)) boundaries.add(item.id)
    } else {
      heads.add(item.head)
      for (const checkpoint of item.checkpoints) checkpoints.add(checkpoint)
    }
  }
  return [...boundaries].filter(
    id => !heads.has(id) && !checkpoints.has(checkpointForCommit(id))
  )
}

/**
 * Validate plain metadata and copy all mutable values. This does not interpret
 * payloads or prove the claimed history coverage. Sets have canonical ordering.
 */
export function copyRecord(record: SedimentreeRecord): SedimentreeRecord {
  if (!(record.blob instanceof Uint8Array) || record.blob.byteLength === 0) {
    throw new TypeError("A record requires non-empty blob bytes")
  }
  // Buffer.slice() borrows memory; constructing a Uint8Array always copies.
  const blob = new Uint8Array(record.blob)
  if (record.kind === "commit") {
    const id = commitId(record.id)
    const parents = [...new Set(record.parents.map(commitId))].sort()
    if (parents.includes(id))
      throw new TypeError("A commit cannot parent itself")
    return { kind: "commit", id, parents, blob }
  }
  if (record.kind === "fragment") {
    return {
      kind: "fragment",
      head: commitId(record.head),
      boundary: [...new Set(record.boundary.map(commitId))].sort(),
      checkpoints: [...new Set(record.checkpoints.map(checkpointId))].sort(),
      blob,
    }
  }
  throw new TypeError("Unknown sedimentree record kind")
}
