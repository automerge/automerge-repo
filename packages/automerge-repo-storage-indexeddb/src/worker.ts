/// <reference lib="webworker" />
/**
 * Worker entrypoint that hosts real {@link IndexedDBStorageAdapter}s and serves
 * them over the {@link STORAGE_RPC} protocol, so the IndexedDB work (structured
 * clone + transaction callbacks) runs off the main thread.
 *
 * Spawned automatically by {@link IndexedDBWorkerStorageAdapter} via
 * `new Worker(new URL("./worker.js", import.meta.url), { type: "module" })`,
 * which the consumer's bundler (Vite/webpack) turns into a real worker bundle.
 *
 * The dispatch logic lives in {@link makeStorageRpcDispatcher} (`worker-handler.ts`)
 * so it can be tested without a browser.
 */
import { makeStorageRpcDispatcher } from "./worker-handler.js"
import type { StorageRpcRequest } from "./worker-rpc.js"

const dispatch = makeStorageRpcDispatcher()

self.onmessage = (e: MessageEvent) => {
  void dispatch(e.data as StorageRpcRequest, (response, transfer) =>
    (self as unknown as Worker).postMessage(response, transfer)
  )
}

export {}
