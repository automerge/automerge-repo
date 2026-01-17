import { Repo } from "@automerge/automerge-repo"
import { BroadcastChannelNetworkAdapter } from "@automerge/automerge-repo-network-broadcastchannel"
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb"
import { WebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket"
import { SubductionStorageBridge } from "@automerge/automerge-repo-subduction-bridge"
import { Subduction } from "@automerge/automerge_subduction"

// // Initialize once as a singleton
// export const repo = new Repo({
//   network: [
//     new BroadcastChannelNetworkAdapter(),
//     new WebSocketClientAdapter("ws://sync.automerge.org"),
//   ],
//   storage: new IndexedDBStorageAdapter(),
// })

export async function setupRepo() {
  const storageAdapter = new IndexedDBStorageAdapter("automerge-repo-svelte-counter")
  const storage = new SubductionStorageBridge(storageAdapter)
  const repo = new Repo({
    network: [new WebSocketClientAdapter("ws://127.0.0.1:8080", 5000, { subductionMode: true })],
    subduction: await Subduction.hydrate(storage),
    subductionStorage: storage,
  })
  return repo
}
