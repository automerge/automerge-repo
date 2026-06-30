/**
 * The {@link STORAGE_RPC} request dispatcher, factored out of `worker.ts` so it
 * can be unit-tested off a real browser (driven by a fake worker) and reused by
 * the actual Worker entrypoint.
 *
 * Hosts real {@link IndexedDBStorageAdapter}s keyed by the request `client`, so
 * one worker can serve several adapters (e.g. one shared worker, several
 * databases).
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

/**
 * Collect the underlying `ArrayBuffer`s from a read result so the caller can
 * transfer (move, not copy) them back to the main thread. The worker has no
 * further use for these bytes once returned. IndexedDB hands back a fresh copy
 * per record, so the buffers are never aliased; we de-dupe defensively. Only
 * real `ArrayBuffer`s are transferable (not `SharedArrayBuffer`).
 */
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

/**
 * Create a dispatcher that answers {@link STORAGE_RPC} requests. The returned
 * function takes a request and a `reply` callback (so the transport — real
 * `postMessage` or a test double — stays out of the dispatch logic).
 */
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
