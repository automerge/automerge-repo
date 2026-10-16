/** One buffer for loading; a single blob is returned as is, without copying. */
export function concatBytes(blobs: readonly Uint8Array[]): Uint8Array {
  if (blobs.length === 0) return new Uint8Array(0)
  if (blobs.length === 1) return blobs[0]
  const total = blobs.reduce((size, blob) => size + blob.byteLength, 0)
  const output = new Uint8Array(total)
  let offset = 0
  for (const blob of blobs) {
    output.set(blob, offset)
    offset += blob.byteLength
  }
  return output
}
