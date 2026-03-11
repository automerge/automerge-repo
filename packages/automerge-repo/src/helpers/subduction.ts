// Type-only imports (don't trigger Wasm access)
import type {
  SedimentreeId as SedimentreeIdType,
  PeerId as SubductionPeerIdType,
} from "@automerge/automerge-subduction"
import { AnyDocumentId, DocumentId, PeerId } from "../types.js"
import bs58check from "bs58check"
import { Doc } from "@automerge/automerge"

// Re-export types for external use
export type { SedimentreeIdType as SedimentreeId }
export type { SubductionPeerIdType as SubductionPeerId }

// Lazy-load constructors via the module registered by setSubductionModule()
// This avoids accessing Wasm before it's initialized
let _subductionModule: typeof import("@automerge/automerge-subduction") | null =
  null

export function _setSubductionModuleForHelpers(
  module: typeof import("@automerge/automerge-subduction")
): void {
  _subductionModule = module
}

function getSubductionModule(): typeof import("@automerge/automerge-subduction") {
  if (_subductionModule === null) {
    throw new Error(
      "Subduction module not set. Call setSubductionModule() after Wasm initialization."
    )
  }
  return _subductionModule
}

// NOTE temporary until we have [u8; 32] peer IDs
export function toSubductionPeerId(peerId: PeerId): SubductionPeerIdType {
  const SubductionPeerId = getSubductionModule().PeerId
  const peerIdBytes = new TextEncoder().encode(peerId)
  const bytes = new Uint8Array(32)
  bytes.set(peerIdBytes.slice(0, 32))
  return new SubductionPeerId(bytes)
}

// NOTE temporary until we have [u8; 32] peer IDs
export function toSedimentreeId(id: AnyDocumentId): SedimentreeIdType {
  const SedimentreeId = getSubductionModule().SedimentreeId
  const docIdBytes = toBinaryDocumentId(id)
  const out = new Uint8Array(32)
  out.set(docIdBytes.subarray(0, 32))
  return SedimentreeId.fromBytes(out)
}

// NOTE temporary until we have [u8; 32] peer IDs
export function toDocumentId(sedimentreeId: SedimentreeIdType): DocumentId {
  // Get the raw bytes and take the first 16 (DocumentId is 16 bytes)
  const bytes = sedimentreeId.toBytes()
  const docIdBytes = bytes.slice(0, 16)
  // Encode as base58check to match automerge-repo's DocumentId format
  return bs58check.encode(docIdBytes) as DocumentId
}

// NOTE temporary until we have [u8; 32] peer IDs
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
