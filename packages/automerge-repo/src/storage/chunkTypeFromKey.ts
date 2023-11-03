import type { StorageKey, ChunkType } from "./types.js"

/**
 * Keys for storing Automerge documents are of the form:
 * ```ts
 * [documentId, "snapshot", hash]  // OR
 * [documentId, "incremental", hash]
 * ```
 * This function returns the chunk type ("snapshot" or "incremental") if the key is in one of these
 * forms.
 */
export function chunkTypeFromKey(key: StorageKey): ChunkType | null {
  if (key.length < 2) return null

  const chunkTypeStr = key[key.length - 2] // next-to-last element in key
  if (chunkTypeStr === "snapshot" || chunkTypeStr === "incremental") {
    return chunkTypeStr as ChunkType
  }

  return null
}
