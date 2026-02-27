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

import type { StorageAdapterInterface } from "@automerge/automerge-repo"
import { setSubductionModule as setRepoModule } from "@automerge/automerge-repo"
import {
  SubductionStorageBridge,
  _setSubductionModuleForStorage,
} from "./storage.js"
import type { Subduction } from "@automerge/automerge-subduction"

export { SubductionStorageBridge, type StorageBridgeEvents } from "./storage.js"
export { NetworkAdapterConnection } from "./network.js"

/**
 * Initialize all subduction module references.
 * Call this after Wasm initialization but before creating any Subduction instances.
 *
 * @example
 * ```ts
 * import * as subductionModule from "@automerge/automerge-subduction"
 * import { initSubductionModule } from "@automerge/automerge-repo-subduction-bridge"
 *
 * initSubductionModule(subductionModule)
 * // Now you can create SubductionStorageBridge and Repo
 * ```
 */
export function initSubductionModule(
  module: typeof import("@automerge/automerge-subduction")
): void {
  setRepoModule(module)
  _setSubductionModuleForStorage(module)
}

/**
 * Options for {@link setupSubduction}.
 */
export interface SetupSubductionOptions {
  /** The namespace import of `@automerge/automerge-subduction` (the Wasm module). */
  subductionModule: typeof import("@automerge/automerge-subduction")
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
  subductionModule,
  signer,
  storageAdapter,
}: SetupSubductionOptions): Promise<SetupSubductionResult> {
  initSubductionModule(subductionModule)
  const storage = new SubductionStorageBridge(storageAdapter)
  const subduction = await subductionModule.Subduction.hydrate(signer, storage)
  return { subduction, storage }
}
