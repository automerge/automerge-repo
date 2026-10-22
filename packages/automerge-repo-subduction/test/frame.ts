// Flip one byte of a stored signed or blob value.
export function corruptFrame(
  frame: Uint8Array,
  field: "signed" | "blob"
): Uint8Array {
  const copy = frame.slice()
  const offsets = { signed: 0, blob: copy.length - 1 }
  copy[offsets[field]] ^= 0xff
  return copy
}
