// Metadata and blob live under separate keys.
export const signedBytes = (metadata: Uint8Array): Uint8Array =>
  metadata.slice()

export function corruptFrame(
  frame: Uint8Array,
  field: "signed" | "blob"
): Uint8Array {
  const copy = frame.slice()
  const offsets = { signed: 0, blob: copy.length - 1 }
  copy[offsets[field]] ^= 0xff
  return copy
}
