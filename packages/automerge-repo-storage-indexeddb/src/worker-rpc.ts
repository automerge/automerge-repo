/**
 * Message protocol shared by {@link IndexedDBWorkerStorageAdapter} (main
 * thread) and `worker.ts` (the Worker hosting real {@link
 * IndexedDBStorageAdapter}s).
 *
 * Every request carries a `client` id so that a single Worker can back
 * multiple adapter instances (e.g. one shared Worker serving several
 * databases): the worker keys its adapters by `client`, and each main-thread
 * proxy ignores responses that don't match its own `client`.
 */

export const STORAGE_RPC = "automerge-repo-idb-storage-rpc" as const

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
  /** Identifies which adapter instance (and its database/store) this is for. */
  client: string
  id: number
  method: StorageRpcMethod
  args: unknown[]
}

export type StorageRpcResponse = {
  channel: typeof STORAGE_RPC
  client: string
  id: number
} & ({ ok: true; result: unknown } | { ok: false; error: string })
