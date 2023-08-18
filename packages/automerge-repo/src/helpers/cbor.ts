import { Encoder, decode as cborXdecode } from "cbor-x";

export function encode(obj: any): Buffer {
  let encoder = new Encoder({tagUint8Array: false})
  return encoder.encode(obj)
}

export function decode(buf: Buffer | Uint8Array): any {
  return cborXdecode(buf)
}
