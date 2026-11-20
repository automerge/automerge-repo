import * as A from "@automerge/automerge/slim"
import {
  checkpointForCommit,
  commitId,
  type CommitId,
  type FragmentRecord,
  type LooseCommitRecord,
  type RecordBatch,
  type SedimentreeRecord,
} from "../index.js"
import { concatBytes } from "../concatBytes.js"

export { isBoundary } from "../records.js"

/** Canonical metadata, without encoding any payloads. Not a coverage proof. */
type RecordMetadata =
  | Omit<LooseCommitRecord, "blob">
  | Omit<FragmentRecord, "blob">

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

/**
 * Encode the current covering representation in one bundling call; pending
 * changes are not included. Returned blobs are owned by the caller.
 */
export function extractRecords(doc: A.Doc<unknown>): SedimentreeRecord[] {
  const native = A.getFragmentMetadata(doc)
  if (native.length === 0) return []
  const blobs = A.bundleFragmentMetadata(doc, native)
  return native.map((meta, index) => ({
    ...project(meta),
    blob: new Uint8Array(blobs[index]),
  }))
}

/** Extract a local delta as loose commits, without scanning fragments.
 * Fragments for new boundary commits are bundled later by
 * {@link extractFragments}. Returned bytes are owned by the caller.
 */
export function extractNewCommits(
  before: A.Doc<unknown>,
  after: A.Doc<unknown>
): LooseCommitRecord[] {
  const heads = A.getHeads(before)
  // Both list changes through the same internal routine, so they share an
  // order; metadata avoids decoding every op of each change.
  const meta = A.getChangesMetaSince(after, heads)
  return A.getChangesSince(after, heads).map((blob, i) => ({
    kind: "commit" as const,
    id: commitId(meta[i].hash),
    parents: canonicalIds(meta[i].deps),
    blob: new Uint8Array(blob),
  }))
}

/**
 * Bundle the fragments headed by these boundary commits, one
 * `getFragmentMeta` lookup per head rather than a full metadata scan. Heads
 * with no fragment of their own (absorbed into a higher one, or unknown to
 * `doc`) are returned as `absent`. Bundles carry their full member history.
 */
export function extractFragments(
  doc: A.Doc<unknown>,
  heads: Iterable<CommitId>
): { records: FragmentRecord[]; absent: CommitId[] } {
  const found: {
    native: A.FragmentMeta
    metadata: Omit<FragmentRecord, "blob">
  }[] = []
  const absent: CommitId[] = []
  for (const head of heads) {
    const native = A.getFragmentMeta(doc, head)
    const metadata = native ? project(native) : undefined
    if (native && metadata?.kind === "fragment")
      found.push({ native, metadata })
    else absent.push(head)
  }
  if (!found.length) return { records: [], absent }
  const blobs = A.bundleFragmentMetadata(
    doc,
    found.map(({ native }) => native)
  )
  return {
    records: found.map(({ metadata }, index) => ({
      ...metadata,
      blob: new Uint8Array(blobs[index]),
    })),
    absent,
  }
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

/**
 * The hashes of the changes in `blob`, a single change or a bundle, and the
 * changes outside it that they depend on. `undefined` if `blob` is
 * neither.
 */
export function changesIn(
  blob: Uint8Array
): { hashes: CommitId[]; deps: CommitId[] } | undefined {
  let bundle: { changes: { hash: string }[]; deps: readonly string[] }
  try {
    const change = A.decodeChange(blob)
    bundle = { changes: [change], deps: change.deps }
  } catch {
    try {
      bundle = A.readBundle(blob)
    } catch {
      return undefined
    }
  }
  return {
    hashes: bundle.changes.map(change => commitId(change.hash)),
    deps: bundle.deps.map(commitId),
  }
}
