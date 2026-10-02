import { Encoder, Decoder } from "cbor-x"
import type { EphemeralEnvelope } from "@automerge/automerge-repo/sedimentree"

const encoder = new Encoder({ useRecords: false })
const decoder = new Decoder({ useRecords: false, mapsAsObjects: true })
export const maxEphemeralBytes = 65536

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256
}
function validate(value: unknown): asserts value is EphemeralEnvelope {
  const message = value as EphemeralEnvelope | undefined
  if (
    !message ||
    !text(message.messageId) ||
    !message.origin ||
    !text(message.origin.kind) ||
    !text(message.origin.id) ||
    !Array.isArray(message.origin.path) ||
    message.origin.path.length > 16 ||
    ![...message.origin.path].every(text) ||
    !(message.payload instanceof Uint8Array)
  )
    throw new TypeError("Invalid ephemeral envelope")
}
export function copyEphemeral(message: EphemeralEnvelope): EphemeralEnvelope {
  return {
    messageId: message.messageId,
    origin: {
      kind: message.origin.kind,
      id: message.origin.id,
      path: [...message.origin.path],
    },
    payload: new Uint8Array(message.payload),
  }
}
export function encodeEphemeral(message: EphemeralEnvelope): Uint8Array {
  validate(message)
  if (message.payload.byteLength > maxEphemeralBytes)
    throw new TypeError("Encoded ephemeral exceeds 65536 bytes")
  const copy = copyEphemeral(message)
  const bytes = encoder.encode([1, copy.messageId, copy.origin, copy.payload])
  if (bytes.byteLength > maxEphemeralBytes)
    throw new TypeError("Encoded ephemeral exceeds 65536 bytes")
  return new Uint8Array(bytes)
}
export function decodeEphemeral(
  bytes: Uint8Array
): EphemeralEnvelope | undefined {
  if (bytes.byteLength > maxEphemeralBytes) return
  try {
    const tuple: unknown = decoder.decode(bytes)
    if (!Array.isArray(tuple) || tuple.length !== 4 || tuple[0] !== 1) return
    const message = { messageId: tuple[1], origin: tuple[2], payload: tuple[3] }
    validate(message)
    return copyEphemeral(message)
  } catch {
    return
  }
}
export function topicKey(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("")
}
/** One bounded insertion-order cache, retained across engine replacements. */
export function rememberEphemeral(seen: Set<string>, key: string): boolean {
  if (seen.has(key)) return false
  seen.add(key)
  if (seen.size > 4096) seen.delete(seen.values().next().value!)
  return true
}
