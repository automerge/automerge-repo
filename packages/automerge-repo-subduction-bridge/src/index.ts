/**
 * Bridges that allow Subduction to use automerge-repo adapters.
 *
 * @example
 * ```ts
 * import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb"
 * import { WebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket"
 * import { Subduction } from "subduction_wasm"
 * import { SubductionStorageBridge, SubductionNetworkBridge } from "@automerge/automerge-repo-subduction-bridge"
 *
 * // Storage bridge
 * const storageAdapter = new IndexedDBStorageAdapter()
 * const storage = new SubductionStorageBridge(storageAdapter)
 *
 * // Network bridge
 * const networkAdapter = new WebSocketClientAdapter("ws://localhost:8080")
 * const network = new SubductionNetworkBridge(networkAdapter)
 *
 * // Create Subduction instance
 * const subduction = await Subduction.hydrate(storage)
 *
 * // Connect to peers
 * const conn = await network.connect(myPeerId, 5000)
 * await subduction.attach(conn)
 * ```
 */

export { SubductionStorageBridge, type StorageBridgeEvents } from "./storage.js"
export { SubductionNetworkBridge, type WebSocketNetworkAdapter } from "./network.js"
