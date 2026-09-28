import {
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

/** Scoped to one sedimentree. This is NOT a representation/content fingerprint. */
export function recordKey(record: SedimentreeRecord): string {
  return `${record.kind}:${record.kind === "commit" ? record.id : record.head}`
}

export function recordHead(record: SedimentreeRecord): CommitId {
  return record.kind === "commit" ? record.id : record.head
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

/** Exact equality of canonical representations, not semantic equivalence. */
export function equalRecords(
  a: SedimentreeRecord,
  b: SedimentreeRecord
): boolean {
  if (recordKey(a) !== recordKey(b)) return false
  if (!equalArrays(a.blob, b.blob)) return false
  if (a.kind === "commit" && b.kind === "commit") {
    return equalArrays(a.parents, b.parents)
  }
  return (
    a.kind === "fragment" &&
    b.kind === "fragment" &&
    equalArrays(a.boundary, b.boundary) &&
    equalArrays(a.checkpoints, b.checkpoints)
  )
}

function equalArrays<T>(a: ArrayLike<T>, b: ArrayLike<T>): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** Encoded payload/metadata budget, not an estimate of the entire JS heap. */
export function recordBytes(record: SedimentreeRecord): number {
  return (
    record.blob.byteLength +
    32 +
    (record.kind === "commit"
      ? record.parents.length * 32
      : record.boundary.length * 32 + record.checkpoints.length * 12)
  )
}
