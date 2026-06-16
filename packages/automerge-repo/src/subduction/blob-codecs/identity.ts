import type { SubductionBlobCodec } from "./types.js"

export const identityBlobCodec: SubductionBlobCodec = {
  async encode(_documentId, blob) {
    return blob
  },

  async decodeMany(_documentId, blobs) {
    return { decoded: blobs, blocked: false }
  },
}
