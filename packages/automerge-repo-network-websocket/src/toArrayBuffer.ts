/**
 * This incantation deals with websocket sending the whole underlying buffer even if we just have a
 * uint8array view on it
 */
export const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const { buffer, byteOffset, byteLength } = bytes
  return buffer.slice(byteOffset, byteOffset + byteLength) as ArrayBuffer
}
