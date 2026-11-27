import { arraysAreEqual } from "../arraysAreEqual.js"
import type { SedimentreeRecord } from "../records.js"

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
  if (!arraysAreEqual(a.blob, b.blob)) return false
  if (a.kind === "commit" && b.kind === "commit") {
    return arraysAreEqual(a.parents, b.parents)
  }
  return (
    a.kind === "fragment" &&
    b.kind === "fragment" &&
    arraysAreEqual(a.boundary, b.boundary) &&
    arraysAreEqual(a.checkpoints, b.checkpoints)
  )
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
