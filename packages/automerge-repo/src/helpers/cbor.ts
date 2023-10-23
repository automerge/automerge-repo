import { Encoder, decode as cborXdecode } from "cbor-x"

export function encode(obj: unknown): Buffer {
  const encoder = new Encoder({ tagUint8Array: false, useRecords: false })
  return encoder.encode(obj)
}

export function decode<T = unknown>(buf: Buffer | Uint8Array): T {
  return cborXdecode(buf)
}
