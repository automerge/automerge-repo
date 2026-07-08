/**
 * The {@link STORAGE_RPC} dispatcher behind `worker.ts`, factored out so it can
 * be tested without a browser. Hosts {@link IndexedDBStorageAdapter}s keyed by
 * the request `client`.
 */
import { IndexedDBStorageAdapter } from "./index.js"
import {
  STORAGE_RPC,
  type StorageRpcMethod,
  type StorageRpcRequest,
  type StorageRpcResponse,
} from "./worker-rpc.js"

export type StorageRpcReply = (
  response: StorageRpcResponse,
  transfer: Transferable[]
) => void

/** The `ArrayBuffer`s in a read result, to transfer back instead of copy. */
export function collectTransfer(
  method: StorageRpcMethod,
  result: unknown
): Transferable[] {
  const buffers = new Set<ArrayBuffer>()
  const add = (buffer: ArrayBufferLike) => {
    if (buffer instanceof ArrayBuffer) buffers.add(buffer)
  }
  if (method === "load") {
    if (result instanceof Uint8Array) add(result.buffer)
  } else if (method === "loadRange") {
    for (const chunk of (result as Array<{ data?: Uint8Array }>) ?? []) {
      if (chunk?.data instanceof Uint8Array) add(chunk.data.buffer)
    }
  }
  return [...buffers]
}

export function makeStorageRpcDispatcher() {
  const adapters = new Map<string, IndexedDBStorageAdapter>()

  return async function dispatch(
    msg: StorageRpcRequest,
    reply: StorageRpcReply
  ): Promise<void> {
    if (!msg || msg.channel !== STORAGE_RPC) return
    const { client, id, method, args } = msg
    try {
      if (method === "init") {
        const [database, store] = args as [string?, string?]
        adapters.set(client, new IndexedDBStorageAdapter(database, store))
        reply(
          { channel: STORAGE_RPC, client, id, ok: true, result: undefined },
          []
        )
        return
      }
      const adapter = adapters.get(client)
      if (!adapter) throw new Error("IndexedDB worker storage not initialized")
      const fn = adapter[method] as (...a: unknown[]) => Promise<unknown>
      const result = await fn.apply(adapter, args)
      reply(
        { channel: STORAGE_RPC, client, id, ok: true, result },
        collectTransfer(method, result)
      )
    } catch (err) {
      reply(
        {
          channel: STORAGE_RPC,
          client,
          id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        },
        []
      )
    }
  }
}
