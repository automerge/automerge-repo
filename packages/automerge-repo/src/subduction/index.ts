/**
 * Bridges that allow Subduction to use automerge-repo adapters.
 *
 * @example
 * ```ts
 * import { WebCryptoSigner } from "@automerge/automerge-subduction"
 * import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb"
 * import { setupSubduction } from "@automerge/automerge-repo-subduction-bridge"
 * import { Repo } from "@automerge/automerge-repo"
 *
 * // Quick setup using the helper
 * const { subduction } = await setupSubduction({
 *   signer: await WebCryptoSigner.setup(),
 *   storageAdapter: new IndexedDBStorageAdapter("my-app"),
 * })
 * const repo = new Repo({ subduction })
 * ```
 */

import type { StorageAdapterInterface } from "../storage/StorageAdapterInterface.js"
import { Subduction, type Signer } from "@automerge/automerge-subduction/slim"
export { SubductionSource, type OnRemoteHeadsChanged } from "./source.js"
export {
  WebSocketEndpoint,
  WorkerWebSocketEndpoint,
  type ManagedTransport,
  type WebSocketEndpointInterface,
  type WorkerWebSocketEndpointOptions,
} from "./websocket-endpoint.js"
export type {
  Policy as SubductionPolicy,
  Transport as SubductionTransport,
} from "@automerge/automerge-subduction/slim"
export type { OnHealExhausted } from "./SyncScheduler.js"

import { SubductionStorageBridge } from "./storage.js"
export { SubductionStorageBridge, type StorageBridgeEvents } from "./storage.js"
export { SUBDUCTION_MESSAGE_TYPE, NetworkAdapterTransport } from "./network.js"
export { WebSocketTransport } from "./websocket-transport.js"
export {
  WorkerWebSocketTransport,
  type WorkerWebSocketConnectOptions,
} from "./worker-websocket/transport.js"
export {
  attachWebSocketHost,
  type WebSocketHostOptions,
  type WebSocketLike,
} from "./worker-websocket/host.js"
export type { WorkerPortLike } from "./worker-websocket/protocol.js"

/**
 * Options for {@link setupSubduction}.
 */
export interface SetupSubductionOptions {
  /**
   * An Ed25519 signer (e.g. `WebCryptoSigner` in the browser, or a `NodeSigner` on the server).
   * Must implement `sign(message: Uint8Array): Uint8Array` and `verifyingKey(): Uint8Array`.
   */
  signer: unknown
  /** An automerge-repo storage adapter (e.g. `IndexedDBStorageAdapter`, `NodeFSStorageAdapter`). */
  storageAdapter: StorageAdapterInterface
}

/**
 * Result of {@link setupSubduction}.
 */
export interface SetupSubductionResult {
  /** The Subduction instance. Pass this to `new Repo({ subduction })`. */
  subduction: Subduction
  /** The storage bridge wrapping your adapter. Subduction persists through this. */
  storage: SubductionStorageBridge
}

/**
 * Convenience helper that initializes the Subduction module references,
 * and wraps a storage adapter with {@link SubductionStorageBridge}
 *
 * @example
 * ```ts
 * import { WebCryptoSigner } from "@automerge/automerge-subduction"
 * import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb"
 * import { setupSubduction } from "@automerge/automerge-repo-subduction-bridge"
 * import { Repo } from "@automerge/automerge-repo"
 *
 * const { subduction } = await setupSubduction({
 *   signer: await WebCryptoSigner.setup(),
 *   storageAdapter: new IndexedDBStorageAdapter("my-app"),
 * })
 *
 * const repo = new Repo({ subduction })
 * ```
 */
export async function setupSubduction({
  signer,
  storageAdapter,
}: SetupSubductionOptions): Promise<SetupSubductionResult> {
  const storage = new SubductionStorageBridge(storageAdapter)
  const subduction = new Subduction({ signer: signer as Signer, storage })
  return { subduction, storage }
}
