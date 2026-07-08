/** RPC protocol between {@link IndexedDBWorkerStorageAdapter} and `worker.ts`. */

export const STORAGE_RPC = "automerge-repo-idb-storage-rpc" as const

/**
 * Wire-protocol version, stamped on every message by the sender and
 * verified by the receiver. The storage worker is often a separately
 * emitted (and separately cached) chunk, so a stale worker can end up
 * talking to a freshly-deployed adapter, or vice versa. A mismatch —
 * including a missing tag from a pre-versioning build — fails loudly
 * instead of silently misbehaving. Bump on any incompatible change.
 */
export const STORAGE_RPC_PROTOCOL_VERSION = 1

/** Does an already-channel-matched message carry the version we speak? */
export const storageRpcVersionOk = (data: unknown): boolean =>
  (data as { v?: unknown }).v === STORAGE_RPC_PROTOCOL_VERSION

/** Human-readable description of a version mismatch, for error surfaces. */
export const storageRpcVersionMismatch = (data: unknown): string => {
  const got = (data as { v?: unknown }).v
  return (
    `IndexedDB storage worker protocol version mismatch: expected ` +
    `v${STORAGE_RPC_PROTOCOL_VERSION}, got ` +
    `${got === undefined ? "an untagged (pre-versioning) message" : `v${String(got)}`}. ` +
    "The storage worker and the adapter are from different builds — likely " +
    "a stale cached worker chunk after a deploy. Reload / clear the worker " +
    "cache so both sides come from the same release."
  )
}

export type StorageRpcMethod =
  | "init"
  | "load"
  | "save"
  | "remove"
  | "loadRange"
  | "removeRange"
  | "saveBatch"

export interface StorageRpcRequest {
  channel: typeof STORAGE_RPC
  /** Protocol version ({@link STORAGE_RPC_PROTOCOL_VERSION}). */
  v: number
  /** Which adapter instance this is for (one worker can back several). */
  client: string
  id: number
  method: StorageRpcMethod
  args: unknown[]
}

export type StorageRpcResponse = {
  channel: typeof STORAGE_RPC
  /** Protocol version ({@link STORAGE_RPC_PROTOCOL_VERSION}). */
  v: number
  client: string
  id: number
} & ({ ok: true; result: unknown } | { ok: false; error: string })
