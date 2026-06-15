import type { DocumentId } from "../../types.js"

export interface DecodeManyResult {
  decoded: Uint8Array[]
  blocked: boolean
}

/**
 * Strategy for transforming Subduction blobs at the Automerge/Subduction
 * boundary. The identity codec is used by default; specialised codecs can
 * encrypt/decrypt, defer blobs until keys arrive, or choose a distinct storage
 * prefix for their transformed representation.
 */
export interface SubductionBlobCodec {
  readonly storagePrefix?: string

  encode(
    documentId: DocumentId,
    blob: Uint8Array
  ): Promise<Uint8Array | null>

  decodeMany(
    documentId: DocumentId,
    blobs: Uint8Array[]
  ): Promise<DecodeManyResult>
}
