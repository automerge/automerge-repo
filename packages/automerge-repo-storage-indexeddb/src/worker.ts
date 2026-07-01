/// <reference lib="webworker" />
/** Worker entrypoint for {@link IndexedDBWorkerStorageAdapter}. */
import { makeStorageRpcDispatcher } from "./worker-handler.js"
import type { StorageRpcRequest } from "./worker-rpc.js"

const dispatch = makeStorageRpcDispatcher()

self.onmessage = (e: MessageEvent) => {
  void dispatch(e.data as StorageRpcRequest, (response, transfer) =>
    (self as unknown as Worker).postMessage(response, transfer)
  )
}

export {}
