import * as A from "@automerge/automerge/slim"
import {
  checkpointForCommit,
  checkpointId,
  commitId,
  type CommitId,
  type FragmentRecord,
  type LooseCommitRecord,
  type RecordBatch,
  type SedimentreeRecord,
} from "../index.js"
import { concatBytes } from "../concatBytes.js"

/** Canonical metadata, without encoding any payloads. Not a coverage proof. */
export type RecordMetadata =
  | Omit<LooseCommitRecord, "blob">
  | Omit<FragmentRecord, "blob">

export type RecordPredicate = (metadata: RecordMetadata) => boolean

function canonicalIds(ids: readonly string[]): CommitId[] {
  return [...new Set(ids.map(commitId))].sort()
}

function project(meta: A.FragmentMeta): RecordMetadata {
  if (meta.level === 0) {
    return Object.freeze({
      kind: "commit",
      id: commitId(meta.head),
      parents: Object.freeze(canonicalIds(meta.boundary)),
    })
  }
  return Object.freeze({
    kind: "fragment",
    head: commitId(meta.head),
    boundary: Object.freeze(canonicalIds(meta.boundary)),
    checkpoints: Object.freeze(
      [
        ...new Set(
          meta.checkpoints.map(hash => checkpointForCommit(commitId(hash)))
        ),
      ].sort()
    ),
  })
}

/** Inspect the current covering representation; pending changes are not included. */
export function getRecordMetadata(doc: A.Doc<unknown>): RecordMetadata[] {
  return A.getFragmentMetadata(doc).map(project)
}

/**
 * Stable key of all canonical metadata, NOT of the encoded representation.
 * Even equal metadata does not prove equal blobs or equivalent history coverage.
 */
export function recordMetadataKey(metadata: RecordMetadata): string {
  if (metadata.kind === "commit") {
    return JSON.stringify([
      "commit",
      commitId(metadata.id),
      canonicalIds(metadata.parents),
    ])
  }
  return JSON.stringify([
    "fragment",
    commitId(metadata.head),
    canonicalIds(metadata.boundary),
    [...new Set(metadata.checkpoints.map(checkpointId))].sort(),
  ])
}

/**
 * Inspect first, then encode ONLY selected metadata in one bundling call.
 * Selection never decodes/serializes all fragments. Returned blobs are owned by
 * the caller. The predicate sees frozen metadata, not Automerge's mutable arrays.
 */
export function extractRecords(
  doc: A.Doc<unknown>,
  select: RecordPredicate = () => true
): SedimentreeRecord[] {
  const selected = A.getFragmentMetadata(doc)
    .map(native => ({ native, metadata: project(native) }))
    .filter(({ metadata }) => select(metadata))
  if (selected.length === 0) return []
  const blobs = A.bundleFragmentMetadata(
    doc,
    selected.map(({ native }) => native)
  )
  return selected.map(({ metadata }, index) => ({
    ...metadata,
    blob: new Uint8Array(blobs[index]),
  }))
}

/** Extract a local delta without scanning historical fragments on ordinary edits.
 * At a fragment boundary, bundle covering records headed by newly added changes.
 * Automerge may update a previous snapshot's shared fragment cache during merge,
 * so comparing the previous snapshot's metadata after mutation is unreliable.
 * The caller must keep exact returned bytes until persistence succeeds.
 */
export function extractNewRecords(
  before: A.Doc<unknown>,
  after: A.Doc<unknown>
): SedimentreeRecord[] {
  const changes = A.getChangesSince(after, A.getHeads(before))
  if (!changes.length) return []
  const decoded = changes.map(blob => ({ blob, change: A.decodeChange(blob) }))
  if (decoded.some(({ change }) => change.hash.startsWith("00"))) {
    const added = new Set(decoded.map(({ change }) => change.hash))
    return extractRecords(after, meta =>
      added.has(meta.kind === "commit" ? meta.id : meta.head)
    )
  }
  return decoded.map(({ blob, change }) => ({
    kind: "commit" as const,
    id: commitId(change.hash),
    parents: canonicalIds(change.deps),
    blob: new Uint8Array(blob),
  }))
}

/**
 * Apply to the latest document in one incremental load, retaining pending
 * dependencies and local edits. Records are trusted: the backend verifies
 * signatures and digests. Feed the return value into subsequent edits/loads.
 * Not a transaction: no rollback if Automerge rejects the input.
 */
export function applyRecords<T>(doc: A.Doc<T>, records: RecordBatch): A.Doc<T> {
  if (records.length === 0) return doc
  return A.loadIncremental(doc, concatBytes(records.map(record => record.blob)))
}

/**
 * History inclusion, not head equality or global pending-dependency emptiness.
 * Empty targets are never evidence that a document is ready.
 */
export function satisfiesMarker(
  doc: A.Doc<unknown>,
  heads: readonly CommitId[]
): boolean {
  const target = canonicalIds(heads)
  return target.length > 0 && A.hasHeads(doc, target)
}
