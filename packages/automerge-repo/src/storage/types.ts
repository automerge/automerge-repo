/**
 * A chunk is a snapshot or incremental change that is stored in a {@link StorageAdapter}.
 */
export type Chunk = {
  key: StorageKey
  data: Uint8Array | undefined
}

/**
 * Metadata about a chunk of data loaded from storage. This is stored on the StorageSubsystem so
 * when we are compacting we know what chunks we can safely delete.
 */
export type ChunkInfo = {
  key: StorageKey
  type: ChunkType
  size: number
}

export type ChunkType = "snapshot" | "incremental"

/**
 * A storage key is an array of strings that represents a path to a value in a
 * {@link StorageAdapter}.
 *
 * @remarks
 * Storage keys are arrays because they are hierarchical and they allow the storage subsystem to do
 * range queries for all keys that have a particular prefix. For example, incremental changes for a
 * given document might be stored under `[<documentId>, "incremental", <SHA256>]`.
 *
 * automerge-repo mostly uses keys in the following form:
 * ```ts
 * [documentId, "snapshot", hash]  // OR
 * [documentId, "incremental", hash]
 * ```
 *
 * However, the storage adapter implementation should be agnostic to the meaning of the key and
 * should not assume any particular structure.
 **/
export type StorageKey = string[]

/** A branded type for storage IDs */
export type StorageId = string & { __storageId: true }
