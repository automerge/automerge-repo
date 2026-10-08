import * as A from "@automerge/automerge/slim"
import { hash as sha256 } from "fast-sha256"
import {
  checkpointForCommit,
  checkpointId,
  commitId,
  copyRecord,
  type CommitId,
  type FragmentRecord,
  type LooseCommitRecord,
  type RecordBatch,
  type SedimentreeRecord,
} from "../index.js"

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
 * Copy and check a record using public Automerge APIs. Fragment validation is
 * structural, not proof of complete sedimentree coverage (see README).
 */
export function validateRecord(record: SedimentreeRecord): SedimentreeRecord {
  const owned = copyRecord(record)
  assertSingleChunk(owned.blob, owned.kind === "commit" ? [1, 2] : [3])
  if (owned.kind === "commit") {
    const change = A.decodeChange(owned.blob)
    // Compressed changes retain the checksum of their uncompressed encoding.
    // decodeChange computes that logical change hash, but doesn't check the
    // supplied checksum. Uncompressed changes can also be checked directly.
    const digest =
      owned.blob[8] === 2
        ? Uint8Array.from(change.hash.match(/../g)!, byte =>
            Number.parseInt(byte, 16)
          )
        : sha256(owned.blob.subarray(8))
    assertChecksum(owned.blob, digest)
    if (
      commitId(change.hash) !== owned.id ||
      !sameIds(canonicalIds(change.deps), owned.parents)
    ) {
      throw new TypeError("Commit metadata does not match its encoded change")
    }
  } else {
    assertChecksum(owned.blob, sha256(owned.blob.subarray(8)))
    const bundle = A.readBundle(owned.blob)
    const members = new Set(bundle.changes.map(change => commitId(change.hash)))
    const dependedOn = new Set(
      bundle.changes.flatMap(change => canonicalIds(change.deps))
    )
    const tips = [...members].filter(hash => !dependedOn.has(hash))
    if (
      members.size !== bundle.changes.length ||
      tips.length !== 1 ||
      tips[0] !== owned.head
    ) {
      throw new TypeError("Fragment head does not match its encoded history")
    }
    // Boundary is sedimentree partition metadata, not the bundle's immediate
    // dependency set (nor necessarily its superset in merge-heavy DAGs). It
    // cannot be authenticated from this standalone blob. Never use this check
    // to authorize coverage deduplication or reclamation.
    const prefixes = new Set([...members].map(checkpointForCommit))
    if (owned.checkpoints.some(prefix => !prefixes.has(prefix))) {
      throw new TypeError(
        "Fragment checkpoint is not represented in its encoded history"
      )
    }
  }
  return owned
}

// Public chunk framing: https://automerge.org/automerge-binary-format-spec/
// Fragment bundles use type 3. readBundle accepts trailing chunks, and even in
// 3.5.0 loadIncremental can silently stop at corruption in a mixed batch.
// Check each entire record envelope before submitting ANY of a batch to it.
function assertSingleChunk(blob: Uint8Array, kinds: readonly number[]): void {
  if (
    blob[0] !== 0x85 ||
    blob[1] !== 0x6f ||
    blob[2] !== 0x4a ||
    blob[3] !== 0x83 ||
    !kinds.includes(blob[8])
  ) {
    throw new TypeError("Unexpected Automerge chunk type or magic bytes")
  }
  let size = 0
  let factor = 1
  for (
    let offset = 9;
    offset < blob.length && factor <= Number.MAX_SAFE_INTEGER;
    offset++
  ) {
    const byte = blob[offset]
    size += (byte & 0x7f) * factor
    if (!Number.isSafeInteger(size)) break
    if ((byte & 0x80) === 0) {
      if (offset > 9 && byte === 0) break // Noncanonical ULEB encoding.
      if (offset + 1 + size === blob.length) return
      break
    }
    factor *= 128
  }
  throw new TypeError("Expected exactly one complete Automerge chunk")
}

function assertChecksum(blob: Uint8Array, digest: Uint8Array): void {
  for (let i = 0; i < 4; i++) {
    if (blob[i + 4] !== digest[i])
      throw new TypeError("Invalid Automerge chunk checksum")
  }
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index])
}

export interface ApplyRecordsOptions {
  /** Maximum concatenation size, default 4 MiB. Oversized records load alone. */
  readonly maxBatchBytes?: number
  /** Maximum records per incremental load, default 256. */
  readonly maxBatchRecords?: number
}

/**
 * Apply to the latest document, retaining pending dependencies and local edits.
 * No deduplication by head: every supplied representation is validated.
 * Feed the return value into subsequent edits/loads. This is synchronous and
 * does not promise rollback if Automerge rejects a later incremental chunk.
 */
export function applyRecords<T>(
  doc: A.Doc<T>,
  records: RecordBatch,
  options: ApplyRecordsOptions = {}
): A.Doc<T> {
  const maxBytes = positiveInteger(options.maxBatchBytes ?? 4 * 1024 * 1024)
  const maxRecords = positiveInteger(options.maxBatchRecords ?? 256)
  // Validate/copy before changing the document. No asynchronous buffer borrowing.
  const owned = records.map(validateRecord)
  let current = doc
  let blobs: Uint8Array[] = []
  let bytes = 0
  const flush = () => {
    if (blobs.length === 0) return
    // One oversized record needs no additional concatenation allocation.
    let input = blobs[0]
    if (blobs.length > 1) {
      input = new Uint8Array(bytes)
      let offset = 0
      for (const blob of blobs) {
        input.set(blob, offset)
        offset += blob.byteLength
      }
    }
    current = A.loadIncremental(current, input)
    blobs = []
    bytes = 0
  }
  for (const { blob } of owned) {
    if (
      blobs.length &&
      (bytes + blob.byteLength > maxBytes || blobs.length >= maxRecords)
    ) {
      flush()
    }
    blobs.push(blob)
    bytes += blob.byteLength
    if (bytes >= maxBytes) flush()
  }
  flush()
  return current
}

function positiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError("Batch limits must be positive safe integers")
  }
  return value
}

/**
 * History inclusion, not head equality or global pending-dependency emptiness.
 * Empty targets are never evidence that a document is ready.
 */
export function satisfiesCheckpoint(
  doc: A.Doc<unknown>,
  heads: readonly CommitId[]
): boolean {
  const target = canonicalIds(heads)
  return target.length > 0 && A.hasHeads(doc, target)
}
