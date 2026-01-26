import { Repo } from "@automerge/automerge-repo"
import { BroadcastChannelNetworkAdapter } from "@automerge/automerge-repo-network-broadcastchannel"
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb"
import { SubductionStorageBridge } from "@automerge/automerge-repo-subduction-bridge"
import { Subduction, SubductionWebSocket, WebCryptoSigner } from "@automerge/automerge_subduction"

export async function setupRepo() {
  const signer = await WebCryptoSigner.setup()
  const storageAdapter = new IndexedDBStorageAdapter("automerge-repo-svelte-counter")
  const storage = new SubductionStorageBridge(storageAdapter)
  const subduction = await Subduction.hydrate(signer, storage)

  // Connect to Subduction server via discovery
  const conn = await SubductionWebSocket.tryDiscover(
    new URL("ws://localhost:8080"),
    signer,
    "0.0.0.0:8080", // Service name (server's default is its socket address)
    5000
  )
  await subduction.attach(conn)

  const repo = new Repo({
    network: [new BroadcastChannelNetworkAdapter()],
    subduction,
  })

  return repo
}
