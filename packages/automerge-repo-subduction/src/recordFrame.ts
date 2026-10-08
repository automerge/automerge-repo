import * as N from "@automerge/subduction/slim"
import type { SedimentreeRecord } from "@automerge/automerge-repo/sedimentree"

type Kind = SedimentreeRecord["kind"]

// One atomic stored value: version, kind, tree, key, envelope digest,
// signed length, signed bytes, then the remaining bytes are the blob.
const VERSION = 1
const HEADER = 1 + 1 + 32 + 32 + 32 + 4
const TREE = 2
const KEY = TREE + 32
const DIGEST = KEY + 32
const LENGTH = DIGEST + 32
const kindByte = (kind: Kind) => (kind === "commit" ? 1 : 3)

function digest(bytes: Uint8Array): Uint8Array {
  const meta = new N.BlobMeta(bytes)
  const hash = meta.digest()
  try {
    return hash.toBytes()
  } finally {
    hash.free()
    meta.free()
  }
}

// Subduction's same-head tie-break hashes Fragment.encode(), not the signed
// envelope. Fragment.encode() = schema(4) + fields; Signed<Fragment>.encode()
// = schema(4) + issuer(32) + fields + signature(64).
export function fragmentPayloadDigest(signed: Uint8Array): Uint8Array {
  if (signed.length < 100) throw new Error("Signed fragment is too short")
  const payload = new Uint8Array(signed.length - 96)
  payload.set(signed.subarray(0, 4))
  payload.set(signed.subarray(36, signed.length - 64), 4)
  return digest(payload)
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index])
}

function nibble(char: number): number {
  if (char >= 48 && char <= 57) return char - 48
  if (char >= 97 && char <= 102) return char - 87
  if (char >= 65 && char <= 70) return char - 55
  return -1
}

// Compare a 32-byte key with the storage path without allocating decoded bytes.
// Neither the key nor its decoded bytes escape this synchronous comparison.
function matchesKey(bytes: Uint8Array, key: string): boolean {
  if (key.length !== 64) return false
  for (let i = 0; i < 32; i++) {
    const a = nibble(key.charCodeAt(i * 2))
    const b = nibble(key.charCodeAt(i * 2 + 1))
    if (a < 0 || b < 0 || bytes[i] !== (a << 4) + b) return false
  }
  return true
}

export function encodeRecordFrame(
  tree: Uint8Array,
  key: Uint8Array,
  record: SedimentreeRecord,
  signed: Uint8Array
): Uint8Array {
  if (signed.length > 0xffffffff) throw new Error("Signed envelope too large")
  if (tree.length !== 32 || key.length !== 32)
    throw new Error("Invalid record tree/key length")
  const frame = new Uint8Array(HEADER + signed.length + record.blob.length)
  frame[0] = VERSION
  frame[1] = kindByte(record.kind)
  frame.set(tree, TREE)
  frame.set(key, KEY)
  frame.set(digest(signed), DIGEST)
  new DataView(frame.buffer).setUint32(LENGTH, signed.length, true)
  frame.set(signed, HEADER)
  frame.set(record.blob, HEADER + signed.length)
  return frame
}

export function decodeRecordFrame(
  tree: Uint8Array,
  kind: Kind,
  key: string,
  value: Uint8Array,
  maxRecordBytes: number
): { encoded: Uint8Array; blob: Uint8Array } {
  if (value.byteLength > maxRecordBytes + HEADER)
    throw new Error("Compound record too large")
  if (
    value.length < HEADER ||
    value[0] !== VERSION ||
    value[1] !== kindByte(kind)
  )
    throw new Error("Invalid compound record version/kind")
  if (
    !sameBytes(value.subarray(TREE, KEY), tree) ||
    !matchesKey(value.subarray(KEY, DIGEST), key)
  )
    throw new Error("Invalid compound record tree/key")
  const length = new DataView(
    value.buffer,
    value.byteOffset,
    value.byteLength
  ).getUint32(LENGTH, true)
  if (length === 0 || length >= value.length - HEADER)
    throw new Error("Invalid compound record lengths")
  // The caller consumes these synchronously. Repo's copyRecord owns the blob;
  // native constructors copy signed bytes into WASM before this value escapes.
  const encoded = value.subarray(HEADER, HEADER + length)
  const blob = value.subarray(HEADER + length)
  // Native hydration trusts stored signatures. This detects damaged envelope
  // bytes, not malicious tampering or signature forgery.
  if (!sameBytes(digest(encoded), value.subarray(DIGEST, LENGTH)))
    throw new Error("Signed envelope checksum mismatch")
  return { encoded, blob }
}
