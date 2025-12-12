import {
  SedimentreeAutomerge,
  SedimentreeId,
  PeerId as SubductionPeerId,
} from "@automerge/automerge_subduction"
import { AnyDocumentId, DocumentId, PeerId } from "../types.js"
import bs58check from "bs58check"
import { Doc } from "@automerge/automerge"

export function toSubductionPeerId(peerId: PeerId): SubductionPeerId {
  const peerIdBytes = new TextEncoder().encode(peerId)
  const bytes = new Uint8Array(32)
  bytes.set(peerIdBytes.slice(0, 32))
  return new SubductionPeerId(bytes)
}

export function toSedimentreeId(id: AnyDocumentId): SedimentreeId {
  const docIdBytes = toBinaryDocumentId(id)
  const out = new Uint8Array(32)
  out.set(docIdBytes.subarray(0, 32))
  return SedimentreeId.fromBytes(out)
}

export function toDocumentId(sedimentreeId: SedimentreeId): DocumentId {
  const str = sedimentreeId.toString()
  const sixteenBytesString = str.substring(0, 16 * 2) as DocumentId
  return sixteenBytesString
}

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

export function toSedimentreeAutomerge(doc: Doc<any>): SedimentreeAutomerge {
  // HACK: the horror!  👹
  const sym = Object.getOwnPropertySymbols(doc).find(
    s => s.description === "_am_meta"
  )!
  const innerDoc = (doc as any)[sym].handle
  return new SedimentreeAutomerge(innerDoc)
}
