/** RPC protocol between {@link IndexedDBWorkerStorageAdapter} and `worker.ts`. */

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
  /** Which adapter instance this is for (one worker can back several). */
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
