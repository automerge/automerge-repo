// Layout of the local, single-value record frame. Test mutations exercise
// decoding of persisted bytes rather than rebuilding frames through the writer.
const digest = 66
const length = 98
const header = 102

export function signedBytes(frame: Uint8Array): Uint8Array {
  const size = new DataView(frame.buffer, frame.byteOffset).getUint32(
    length,
    true
  )
  return frame.slice(header, header + size)
}

export function corruptFrame(
  frame: Uint8Array,
  field:
    | "version"
    | "kind"
    | "tree"
    | "key"
    | "signed"
    | "digest"
    | "blob"
    | "length"
): Uint8Array {
  const copy = frame.slice()
  const signedLength = new DataView(copy.buffer).getUint32(length, true)
  const offsets = {
    version: 0,
    kind: 1,
    tree: 2,
    key: 34,
    digest,
    length,
    signed: header + signedLength - 1,
    blob: copy.length - 1,
  }
  copy[offsets[field]] ^= 0xff
  return copy
}
