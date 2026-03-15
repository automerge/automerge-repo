import React from "react"
import ReactDOM from "react-dom/client"
import { App } from "./App"
import {
  Repo,
  isValidAutomergeUrl,
  BroadcastChannelNetworkAdapter,
  WebSocketClientAdapter,
  IndexedDBStorageAdapter,
  RepoContext,
} from "@automerge/react"
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
import { v4 } from "uuid"

// Initialize Subduction Wasm from base64
// (use /slim to avoid wasm-bodge bundler.js dual-module class identity issue)
initSync(Uint8Array.from(atob(wasmBase64), c => c.charCodeAt(0)))
initSubductionModule(subductionModule)
;(async () => {
  const signer = await WebCryptoSigner.setup()
  const storageAdapter = new IndexedDBStorageAdapter(
    "automerge-repo-use-presence"
  )
  const storage = new SubductionStorageBridge(storageAdapter)
  const subduction = await Subduction.hydrate(signer, storage)

  await subduction.connectDiscover(new URL("ws://localhost:8080"))

  const repo = new Repo({
    network: [
      new BroadcastChannelNetworkAdapter(),
      new WebSocketClientAdapter("ws://localhost:8081"),
    ],
    subduction,
  })

  const userId = v4()

  const rootDocUrl = `${document.location.hash.substring(1)}`
  const handle = isValidAutomergeUrl(rootDocUrl)
    ? await repo.find(rootDocUrl)
    : repo.create()

  const docUrl = (document.location.hash = handle.url)

  ReactDOM.createRoot(document.getElementById("root")!).render(
    <RepoContext.Provider value={repo}>
      <React.StrictMode>
        <App userId={userId} url={docUrl} />
      </React.StrictMode>
    </RepoContext.Provider>
  )
})()
