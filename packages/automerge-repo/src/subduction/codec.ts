/**
 * Tagged compound value for a single stored commit/fragment record.
 *
 * The Subduction storage bridge stores each commit (and fragment) as a `meta`
 * blob (the signed `SignedLooseCommit` / `SignedFragment` wire bytes) plus the
 * Automerge change/bundle `blob`. Historically these were two separate
 * IndexedDB records per commit. To roughly halve the write count, small blobs
 * are now stored *inline* in the same record as the meta; only blobs larger
 * than {@link INLINE_THRESHOLD} are written to a separate `blobs` record.
 *
 * Wire format (mirrors the redb storage in the `subduction` repo,
 * `subduction_redb_storage/src/codec.rs`):
 *
 * ```text
 *   0x00 ++ meta_len:u32be ++ meta ++ blob   (inline)
 *   0x01 ++ meta                             (external; blob in a sibling record)
 * ```
 *
 * The tag byte disambiguates the two shapes; an external value is just the
 * meta with no length prefix (the meta is the whole remainder).
 */

/** Largest blob (bytes) stored inline alongside its meta. Matches redb's
 * `DEFAULT_INLINE_THRESHOLD`. ~99.4% of real-world commit blobs fall under it. */
export const INLINE_THRESHOLD = 16 * 1024

const TAG_INLINE = 0x00
const TAG_EXTERNAL = 0x01

/** A decoded compound value, before any external-blob resolution. */
export type DecodedCompound =
  | { kind: "inline"; meta: Uint8Array; blob: Uint8Array }
  | { kind: "external"; meta: Uint8Array }

/** `true` if `blob` should be stored inline (i.e. `<= INLINE_THRESHOLD`). */
export const shouldInline = (blob: Uint8Array): boolean =>
  blob.byteLength <= INLINE_THRESHOLD

/** Encode an inline compound value: `0x00 ++ meta_len:u32be ++ meta ++ blob`. */
export const encodeInline = (
  meta: Uint8Array,
  blob: Uint8Array
): Uint8Array => {
  const out = new Uint8Array(1 + 4 + meta.byteLength + blob.byteLength)
  out[0] = TAG_INLINE
  new DataView(out.buffer).setUint32(1, meta.byteLength, false) // big-endian
  out.set(meta, 5)
  out.set(blob, 5 + meta.byteLength)
  return out
}

/** Encode an external compound value: `0x01 ++ meta` (blob stored separately). */
export const encodeExternal = (meta: Uint8Array): Uint8Array => {
  const out = new Uint8Array(1 + meta.byteLength)
  out[0] = TAG_EXTERNAL
  out.set(meta, 1)
  return out
}

/** Decode a compound value, or `null` on a malformed/legacy buffer. */
export const decodeCompound = (bytes: Uint8Array): DecodedCompound | null => {
  if (bytes.byteLength < 1) return null
  switch (bytes[0]) {
    case TAG_INLINE: {
      if (bytes.byteLength < 5) return null
      const metaLen = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength
      ).getUint32(1, false)
      if (bytes.byteLength < 5 + metaLen) return null
      return {
        kind: "inline",
        meta: bytes.subarray(5, 5 + metaLen),
        blob: bytes.subarray(5 + metaLen),
      }
    }

    case TAG_EXTERNAL:
      return { kind: "external", meta: bytes.subarray(1) }

    default:
      return null
  }
}

/**
 * Extract just the meta of a compound value plus whether its blob is external,
 * without copying the (possibly large) inline blob. `null` on a malformed
 * buffer.
 */
export const splitMeta = (
  bytes: Uint8Array
): { external: boolean; meta: Uint8Array } | null => {
  const decoded = decodeCompound(bytes)
  if (!decoded) return null
  return decoded.kind === "inline"
    ? { external: false, meta: decoded.meta }
    : { external: true, meta: decoded.meta }
}
