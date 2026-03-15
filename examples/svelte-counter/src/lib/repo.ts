import { Repo } from "@automerge/automerge-repo"
import { BroadcastChannelNetworkAdapter } from "@automerge/automerge-repo-network-broadcastchannel"
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb"
import {
  SubductionStorageBridge,
  initSubductionModule,
} from "@automerge/automerge-repo-subduction-bridge"
import { initSync } from "@automerge/automerge-subduction/slim"
import * as subductionModule from "@automerge/automerge-subduction/slim"
import {
  Subduction,
  WebCryptoSigner,
} from "@automerge/automerge-subduction/slim"
import { wasmBase64 } from "@automerge/automerge-subduction/wasm-base64"

// Initialize Subduction Wasm from base64 (use /slim to avoid bundler.js dual-module class identity issue)
initSync(Uint8Array.from(atob(wasmBase64), c => c.charCodeAt(0)))
initSubductionModule(subductionModule)

export async function setupRepo() {
  const signer = await WebCryptoSigner.setup()
  const storageAdapter = new IndexedDBStorageAdapter(
    "automerge-repo-svelte-counter"
  )
  const storage = new SubductionStorageBridge(storageAdapter)
  const subduction = await Subduction.hydrate(signer, storage)

  await subduction.connectDiscover(new URL("ws://localhost:8080"))

  const repo = new Repo({
    network: [new BroadcastChannelNetworkAdapter()],
    subduction,
  })

  return repo
}
