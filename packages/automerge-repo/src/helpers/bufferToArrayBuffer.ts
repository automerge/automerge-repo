export const bufferToArrayBuffer = (buffer: Buffer | Uint8Array) => {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  )
}
