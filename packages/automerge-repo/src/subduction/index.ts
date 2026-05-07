/**
 * Bridges that allow Subduction to use automerge-repo adapters.
 *
 * @example
 * ```ts
 * import * as subductionModule from "@automerge/automerge-subduction"
 * import { WebCryptoSigner } from "@automerge/automerge-subduction"
 * import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb"
 * import { setupSubduction } from "@automerge/automerge-repo-subduction-bridge"
 * import { Repo } from "@automerge/automerge-repo"
 *
 * // Quick setup using the helper
 * const { subduction } = await setupSubduction({
 *   subductionModule,
 *   signer: await WebCryptoSigner.setup(),
 *   storageAdapter: new IndexedDBStorageAdapter("my-app"),
 * })
 * const repo = new Repo({ subduction })
 * ```
 */

import type { StorageAdapterInterface } from "@automerge/automerge-repo/slim"
import { Subduction } from "@automerge/automerge-subduction/slim"
export {
  SubductionSource,
  type OnHealExhausted,
  type OnRemoteHeadsChanged,
} from "./source.js"

import { SubductionStorageBridge } from "./storage.js"
export { SubductionStorageBridge, type StorageBridgeEvents } from "./storage.js"
export { SUBDUCTION_MESSAGE_TYPE, NetworkAdapterTransport } from "./network.js"
export { WebSocketTransport } from "./websocket-transport.js"

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
  /** The hydrated Subduction instance. Pass this to `new Repo({ subduction })`. */
  subduction: Subduction
  /** The storage bridge wrapping your adapter. Subduction persists through this. */
  storage: SubductionStorageBridge
}

/**
 * Convenience helper that initializes the Subduction module references,
 * wraps a storage adapter with {@link SubductionStorageBridge}, and
 * hydrates a {@link Subduction} instance.
 *
 * @example
 * ```ts
 * import * as subductionModule from "@automerge/automerge-subduction"
 * import { WebCryptoSigner } from "@automerge/automerge-subduction"
 * import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb"
 * import { setupSubduction } from "@automerge/automerge-repo-subduction-bridge"
 * import { Repo } from "@automerge/automerge-repo"
 *
 * const { subduction } = await setupSubduction({
 *   subductionModule,
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
  const subduction = await Subduction.hydrate(signer, storage)
  return { subduction, storage }
}
