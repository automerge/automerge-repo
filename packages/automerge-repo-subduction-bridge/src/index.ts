/**
 * Bridges that allow Subduction to use automerge-repo adapters.
 *
 * @example
 * ```ts
 * import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb"
 * import { BroadcastChannelNetworkAdapter } from "@automerge/automerge-repo-network-broadcastchannel"
 * import { Subduction, SubductionWebSocket, PeerId } from "@automerge/automerge_subduction"
 * import { SubductionStorageBridge, NetworkAdapterConnection } from "@automerge/automerge-repo-subduction-bridge"
 *
 * // Storage bridge - works with any automerge-repo storage adapter
 * const storageAdapter = new IndexedDBStorageAdapter()
 * const storage = new SubductionStorageBridge(storageAdapter)
 *
 * // Create Subduction instance
 * const subduction = await Subduction.hydrate(storage)
 *
 * // For WebSocket connections to a Subduction server, use SubductionWebSocket directly:
 * const wsConn = await SubductionWebSocket.connect(new URL("ws://localhost:8080"), myPeerId, 5000)
 * await subduction.attach(wsConn)
 *
 * // For local peer-to-peer (BroadcastChannel, MessageChannel), use NetworkAdapterConnection:
 * const broadcastAdapter = new BroadcastChannelNetworkAdapter()
 * broadcastAdapter.connect(myRepoPeerId)
 * broadcastAdapter.on("peer-candidate", ({ peerId: remotePeerId }) => {
 *   const conn = new NetworkAdapterConnection(broadcastAdapter, mySubductionPeerId, remotePeerId)
 *   subduction.attach(conn)
 * })
 * ```
 */

export { SubductionStorageBridge, type StorageBridgeEvents } from "./storage.js"
export { NetworkAdapterConnection } from "./network.js"
