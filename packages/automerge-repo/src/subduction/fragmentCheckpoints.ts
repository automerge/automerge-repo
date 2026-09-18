/**
 * Sedimentree reads a fragment's checkpoints as the commits it covers below
 * its head, and `Sedimentree::heads_assuming_minimal` (subduction 0.17) drops
 * every id listed among any fragment's checkpoints from the heads. A fragment
 * whose checkpoints include its own head therefore never contributes a head:
 * when the document's newest change is that head, every peer holding the
 * fragment advertises no heads (or a stale ancestor) while automerge reports
 * the head. `Fragment::supports_block` matches a fragment's head and boundary
 * on their own, so leaving them out of the checkpoints loses nothing.
 *
 * Automerge before 3.5 lists every fragment's head among its checkpoints.
 */

/**
 * The checkpoints to record for a fragment: automerge's, without the
 * fragment's own head or boundary.
 */
export function fragmentCheckpoints(meta: {
  head: string
  boundary: string[]
  checkpoints: string[]
}): string[] {
  return meta.checkpoints.filter(
    c => c !== meta.head && !meta.boundary.includes(c)
  )
}

/** A fragment's head and boundary ids, and its truncated checkpoints. */
export interface FragmentParts {
  head: Uint8Array
  boundary: Uint8Array[]
  checkpoints: Uint8Array[]
}

// A `SignedFragment` as sedimentree_core encodes it (schema "STF", version 0):
//
//   schema[4] issuer[32] sedimentreeId[32] head[32] blobDigest[32]
//   boundaryCount:u8 checkpointCount:u16be blobSize:bijou64(1-9 bytes)
//   boundary[32]... checkpoints[12]... signature[64]
//
// The JS `Fragment` exposes no checkpoints, so they are read from here.
const SCHEMA = [0x53, 0x54, 0x46, 0x00]
const HEAD_OFFSET = 68
const COUNTS_OFFSET = 132
const BLOB_SIZE_OFFSET = 135
const ID_BYTES = 32
const CHECKPOINT_BYTES = 12
const SIGNATURE_BYTES = 64

/**
 * For an encoded `SignedFragment` whose checkpoints include its own head, the
 * parts to store it again with: its head and boundary, and its checkpoints
 * without the head's or the boundary's. `undefined` when the fragment does not
 * list its own head, or when `signed` is not an encoding this reads.
 */
export function selfCheckpointRepair(
  signed: Uint8Array
): FragmentParts | undefined {
  const minLength = BLOB_SIZE_OFFSET + 1 + SIGNATURE_BYTES
  if (signed.length < minLength) return undefined
  if (SCHEMA.some((byte, i) => signed[i] !== byte)) return undefined

  const boundaryCount = signed[COUNTS_OFFSET]
  const checkpointCount =
    (signed[COUNTS_OFFSET + 1] << 8) | signed[COUNTS_OFFSET + 2]
  // bijou64 takes its length from the first byte: below 0xf8 the byte is
  // the value, 0xf8..0xff prefix 1..8 more bytes.
  const tag = signed[BLOB_SIZE_OFFSET]
  const boundaryOffset = BLOB_SIZE_OFFSET + (tag < 0xf8 ? 1 : tag - 0xf6)
  const checkpointsOffset = boundaryOffset + boundaryCount * ID_BYTES
  const signatureOffset = checkpointsOffset + checkpointCount * CHECKPOINT_BYTES
  if (signatureOffset + SIGNATURE_BYTES !== signed.length) return undefined

  const slices = (offset: number, count: number, size: number) =>
    Array.from({ length: count }, (_, i) =>
      signed.slice(offset + i * size, offset + (i + 1) * size)
    )
  const head = signed.slice(HEAD_OFFSET, HEAD_OFFSET + ID_BYTES)
  const boundary = slices(boundaryOffset, boundaryCount, ID_BYTES)
  const checkpoints = slices(
    checkpointsOffset,
    checkpointCount,
    CHECKPOINT_BYTES
  )

  const truncates = (checkpoint: Uint8Array, id: Uint8Array) =>
    checkpoint.every((byte, i) => byte === id[i])
  if (!checkpoints.some(c => truncates(c, head))) return undefined
  return {
    head,
    boundary,
    checkpoints: checkpoints.filter(
      c => !truncates(c, head) && !boundary.some(b => truncates(c, b))
    ),
  }
}
