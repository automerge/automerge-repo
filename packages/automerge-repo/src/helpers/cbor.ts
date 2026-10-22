import { Encoder, decode as cborXdecode } from "cbor-x"

const encoder = new Encoder({ tagUint8Array: false, useRecords: false })

/** A plain Uint8Array view (cbor-x returns a Buffer under Node). */
export function encode(obj: unknown): Uint8Array {
  const bytes = encoder.encode(obj)
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

export function decode<T = unknown>(buf: Uint8Array): T {
  return cborXdecode(buf)
}
