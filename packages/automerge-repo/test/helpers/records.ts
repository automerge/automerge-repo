import type { SedimentreeRecord } from "../../src/sedimentree/index.js"

/** Scoped to one sedimentree. This is NOT a representation/content fingerprint. */
export function recordKey(record: SedimentreeRecord): string {
  return `${record.kind}:${record.kind === "commit" ? record.id : record.head}`
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
