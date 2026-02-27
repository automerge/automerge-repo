import { Repo } from "@automerge/automerge-repo"
import { BroadcastChannelNetworkAdapter } from "@automerge/automerge-repo-network-broadcastchannel"
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb"
import {
  SubductionStorageBridge,
  initSubductionModule,
} from "@automerge/automerge-repo-subduction-bridge"
import * as subductionModule from "@automerge/automerge-subduction"
import {
  Subduction,
  SubductionWebSocket,
  WebCryptoSigner,
} from "@automerge/automerge-subduction"

initSubductionModule(subductionModule)

export async function setupRepo() {
  const signer = await WebCryptoSigner.setup()
  const storageAdapter = new IndexedDBStorageAdapter(
    "automerge-repo-svelte-counter"
  )
  const storage = new SubductionStorageBridge(storageAdapter)
  const subduction = await Subduction.hydrate(signer, storage)

  // Connect to Subduction server via discovery
  const conn = await SubductionWebSocket.tryDiscover(
    new URL("ws://localhost:8080"),
    signer
  )
  await subduction.attach(conn)

  const repo = new Repo({
    network: [new BroadcastChannelNetworkAdapter()],
    subduction,
  })

  return repo
}
