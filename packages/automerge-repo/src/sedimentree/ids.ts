/** Canonical lowercase hex of exactly 32 bytes. */
export type SedimentreeId = string & { readonly __sedimentreeId: unique symbol }
/** Caller-supplied logical identity, not necessarily a hash of stored bytes. */
export type CommitId = string & { readonly __commitId: unique symbol }
/** Sedimentree's 12-byte checkpoint prefix, distinct from a full commit ID. */
export type CheckpointId = string & { readonly __checkpointId: unique symbol }

function canonicalHex(value: string | Uint8Array): string {
  const hex =
    typeof value === "string"
      ? value.toLowerCase()
      : Array.from(value, byte => byte.toString(16).padStart(2, "0")).join("")
  if (!/^(?:[0-9a-f]{2})+$/.test(hex)) {
    throw new TypeError("Expected non-empty hexadecimal bytes")
  }
  return hex
}

export function sedimentreeId(value: string | Uint8Array): SedimentreeId {
  const hex = canonicalHex(value)
  if (hex.length !== 64) {
    throw new TypeError("A sedimentree ID must be 32 bytes")
  }
  return hex as SedimentreeId
}

/**
 * Default document ID minter. Currently 16 random bytes then 16 zero bytes:
 * keyhive-enabled Subduction servers accept such IDs without authorization.
 * The first half is never all zero.
 */
export function mintDocumentId(): SedimentreeId {
  const bytes = new Uint8Array(32)
  do crypto.getRandomValues(bytes.subarray(0, 16))
  while (bytes.subarray(0, 16).every(byte => byte === 0))
  return sedimentreeId(bytes)
}

export function commitId(value: string | Uint8Array): CommitId {
  const hex = canonicalHex(value)
  if (hex.length !== 64) throw new TypeError("A commit ID must be 32 bytes")
  return hex as CommitId
}

export function checkpointId(value: string | Uint8Array): CheckpointId {
  const hex = canonicalHex(value)
  if (hex.length !== 24)
    throw new TypeError("A checkpoint prefix must be 12 bytes")
  return hex as CheckpointId
}

export function checkpointForCommit(id: CommitId): CheckpointId {
  return checkpointId(commitId(id).slice(0, 24))
}

/** Returns a fresh buffer. */
export function idBytes(
  id: SedimentreeId | CommitId | CheckpointId
): Uint8Array {
  const hex = canonicalHex(id)
  return Uint8Array.from(hex.match(/../g)!, pair => Number.parseInt(pair, 16))
}
