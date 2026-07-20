/**
 * Port-agnostic storage host: attach the {@link STORAGE_RPC} dispatcher to
 * any message port. Used by the shipped worker entries (`worker.ts`,
 * `worker-shared.ts`) and by consumer-authored entries that host storage
 * and other proxies (e.g. the Subduction WebSocket host) on one port.
 */
import type { WorkerPortLike } from "@automerge/automerge-repo/slim"
import { makeStorageRpcDispatcher } from "./worker-handler.js"
import type { StorageRpcRequest } from "./worker-rpc.js"

/**
 * Attach a storage RPC host to a port. Returns a detach function.
 *
 * Pass a shared `dispatch` (from {@link makeStorageRpcDispatcher}) to let
 * several ports address the same adapter set; by default each port gets
 * its own. Requests are keyed by `client`, so several adapters can share
 * one port either way.
 */
export function attachStorageHost(
  port: WorkerPortLike,
  dispatch: ReturnType<
    typeof makeStorageRpcDispatcher
  > = makeStorageRpcDispatcher()
): () => void {
  const onMessage = (e: MessageEvent) => {
    void dispatch(e.data as StorageRpcRequest, (response, transfer) =>
      port.postMessage(response, transfer)
    )
  }

  const detach = () => {
    port.removeEventListener("message", onMessage)
    port.removeEventListener("close", detach)
  }

  port.addEventListener("message", onMessage)
  // MessagePort-only: stop dispatching for a dead client context.
  port.addEventListener("close", detach)
  port.start?.()

  return detach
}
