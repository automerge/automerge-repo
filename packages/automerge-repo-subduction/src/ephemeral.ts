import { Encoder } from "cbor-x"
import {
  BackendError,
  type EphemeralEnvelope,
} from "@automerge/automerge-repo/sedimentree"

// Untagged byte strings keep the encoding identical with and without Node's Buffer.
const codec = new Encoder({ useRecords: false, tagUint8Array: false })
export const maxEphemeralBytes = 65536

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256
}
function isEnvelope(value: unknown): value is EphemeralEnvelope {
  const message = value as EphemeralEnvelope | undefined
  return (
    !!message &&
    text(message.messageId) &&
    !!message.origin &&
    text(message.origin.kind) &&
    text(message.origin.id) &&
    Array.isArray(message.origin.path) &&
    message.origin.path.length <= 16 &&
    [...message.origin.path].every(text) &&
    message.payload instanceof Uint8Array
  )
}
function invalid(message: string): BackendError {
  return new BackendError("ephemeral", "invalid-record", message)
}
export function encodeEphemeral(message: EphemeralEnvelope): Uint8Array {
  if (!isEnvelope(message)) throw invalid("Invalid ephemeral envelope")
  const { messageId, origin, payload } = message
  const { kind, id, path } = origin
  const bytes = codec.encode([1, messageId, { kind, id, path }, payload])
  if (bytes.byteLength > maxEphemeralBytes)
    throw invalid("Encoded ephemeral exceeds 65536 bytes")
  // A plain view: cbor-x returns a Buffer under Node.
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}
/** Decoded metadata is frozen; the payload is a view of `bytes`. */
export function decodeEphemeral(
  bytes: Uint8Array
): EphemeralEnvelope | undefined {
  if (bytes.byteLength > maxEphemeralBytes) return
  try {
    const tuple: unknown = codec.decode(bytes)
    if (!Array.isArray(tuple) || tuple.length !== 4 || tuple[0] !== 1) return
    const [, messageId, origin, payload] = tuple
    const message = { messageId, origin, payload }
    if (!isEnvelope(message)) return
    const { kind, id, path } = message.origin
    return Object.freeze({
      messageId,
      origin: Object.freeze({ kind, id, path: Object.freeze(path) }),
      payload,
    })
  } catch {
    return
  }
}
