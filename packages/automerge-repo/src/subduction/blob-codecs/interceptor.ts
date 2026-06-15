import type { DocumentId } from "../../types.js"
import type { SubductionBlobCodec } from "./types.js"

/** Intercepts and transforms incoming and outgoing blobs (e.g., for E2EE). */
export interface BlobInterceptor {
  /** Return null to skip the blob (e.g., doc not yet available for encryption). */
  transformOutgoing(
    documentId: DocumentId,
    blob: Uint8Array
  ): Promise<Uint8Array | null>
  /** Return null to skip the blob. */
  transformIncoming(
    documentId: DocumentId,
    blob: Uint8Array
  ): Promise<Uint8Array | null>
}

/**
 * Storage-key prefix for a subduction store whose Repo has a blob interceptor
 * configured. An interceptor transforms the stored representation (e.g.,
 * encrypts it), so its commits must not share keys with untransformed commits.
 */
export const INTERCEPTOR_PREFIX = "subduction-interceptor"

export function blobCodecFromInterceptor(
  interceptor: BlobInterceptor
): SubductionBlobCodec {
  return {
    storagePrefix: INTERCEPTOR_PREFIX,

    encode(documentId, blob) {
      return interceptor.transformOutgoing(documentId, blob)
    },

    async decodeMany(documentId, blobs) {
      // Transforming one blob may let the interceptor transform others that
      // failed on an earlier pass. Re-run over the still-pending blobs until a
      // pass makes no progress. Each pass strictly shrinks `pending` or stops,
      // so this runs at most N passes.
      const decoded: Uint8Array[] = []
      let pending = blobs
      let prevPendingLen = pending.length + 1

      while (pending.length > 0 && pending.length < prevPendingLen) {
        prevPendingLen = pending.length
        const stillPending: Uint8Array[] = []
        for (const blob of pending) {
          const result = await interceptor.transformIncoming(documentId, blob)
          if (result) {
            decoded.push(result)
          } else {
            stillPending.push(blob)
          }
        }
        pending = stillPending
      }

      return { decoded, blocked: pending.length > 0 }
    },
  }
}
