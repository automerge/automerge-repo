/** Message protocol shared by {@link IndexedDBWorkerStorageAdapter} (main
 * thread) and `worker.ts` (the Worker hosting a real IndexedDBStorageAdapter). */

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
  id: number
  method: StorageRpcMethod
  args: unknown[]
}

export type StorageRpcResponse = {
  channel: typeof STORAGE_RPC
  id: number
} & ({ ok: true; result: unknown } | { ok: false; error: string })
