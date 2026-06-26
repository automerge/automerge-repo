/// <reference lib="webworker" />
/**
 * Worker that hosts a real {@link IndexedDBStorageAdapter} and serves it over
 * the {@link STORAGE_RPC} message protocol, so the IndexedDB work (structured
 * clone + transaction callbacks) runs off the main thread.
 *
 * Spawned automatically by {@link IndexedDBWorkerStorageAdapter} via
 * `new Worker(new URL("./worker.js", import.meta.url), { type: "module" })`,
 * which the consumer's bundler (Vite/webpack) turns into a real worker bundle.
 */
import { IndexedDBStorageAdapter } from "./IndexedDBStorageAdapter.js"
import { STORAGE_RPC, type StorageRpcRequest } from "./worker-rpc.js"

let adapter: IndexedDBStorageAdapter | null = null

const reply = (id: number, body: Record<string, unknown>) =>
  (self as unknown as Worker).postMessage({ channel: STORAGE_RPC, id, ...body })

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data as StorageRpcRequest
  if (!msg || msg.channel !== STORAGE_RPC) return
  try {
    if (msg.method === "init") {
      const [database, store] = msg.args as [string?, string?]
      adapter = new IndexedDBStorageAdapter(database, store)
      reply(msg.id, { ok: true, result: undefined })
      return
    }
    if (!adapter) throw new Error("IndexedDB worker storage not initialized")
    const fn = adapter[msg.method] as (...a: unknown[]) => Promise<unknown>
    const result = await fn.apply(adapter, msg.args)
    reply(msg.id, { ok: true, result })
  } catch (err) {
    reply(msg.id, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export {}
