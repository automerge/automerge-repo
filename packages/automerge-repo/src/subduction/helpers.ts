import { SedimentreeId } from "@automerge/automerge-subduction/slim"
import { AnyDocumentId, DocumentId } from "../types.js"
import bs58check from "bs58check"
import { type Doc } from "@automerge/automerge/slim"

export function toSedimentreeId(id: AnyDocumentId): SedimentreeId {
  const docIdBytes = toBinaryDocumentId(id)
  const out = new Uint8Array(32)
  out.set(docIdBytes.subarray(0, 32))
  return SedimentreeId.fromBytes(out)
}

// NOTE temporary: zero-pads 16-byte DocumentId to 32-byte SedimentreeId
export function toDocumentId(sedimentreeId: SedimentreeId): DocumentId {
  // Get the raw bytes and take the first 16 (DocumentId is 16 bytes)
  const bytes = sedimentreeId.toBytes()
  const docIdBytes = bytes.slice(0, 16)
  // Encode as base58check to match automerge-repo's DocumentId format
  return bs58check.encode(docIdBytes) as DocumentId
}

// NOTE temporary: bridges DocumentId formats (string/URL/bytes → raw bytes)
function toBinaryDocumentId(id: AnyDocumentId): Uint8Array {
  if (id instanceof Uint8Array) {
    return id
  }

  if (typeof id === "string") {
    if (id.startsWith("automerge:")) {
      return bs58check.decode(id.slice("automerge:".length))
    }

    // Legacy hex-encoded UUID
    if (/^[0-9a-fA-F]{32,}$/.test(id)) {
      const bytes = new Uint8Array(id.length / 2)
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(id.substr(i * 2, 2), 16)
      }
      return bytes
    }

    return bs58check.decode(id)
  }

  throw new TypeError("Unsupported document ID format")
}

// TODO: get this exposed upstream with exported types
export function automergeMeta(doc: Doc<any>): any {
  // HACK: the horror!  👹
  const am_meta = Object.getOwnPropertySymbols(doc).find(
    s => s.description === "_am_meta"
  )!
  return (doc as any)[am_meta].handle
}
