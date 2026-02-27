import React from "react"
import ReactDOM from "react-dom/client"
import { App } from "./App.js"
import {
  Repo,
  isValidAutomergeUrl,
  IndexedDBStorageAdapter,
  RepoContext,
} from "@automerge/react"
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
;(async () => {
  const signer = await WebCryptoSigner.setup()
  const storageAdapter = new IndexedDBStorageAdapter(
    "automerge-repo-demo-counter"
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
    network: [],
    subduction,
    sharePolicy: async peerId => peerId.includes("shared-worker"),
  })

  const rootDocUrl = `${document.location.hash.substring(1)}`
  let handle
  if (isValidAutomergeUrl(rootDocUrl)) {
    handle = await repo.find(rootDocUrl)
  } else {
    handle = repo.create<{ count: number }>({ count: 0 })
  }
  const docUrl = (document.location.hash = handle.url)

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <RepoContext.Provider value={repo}>
      <React.StrictMode>
        <App url={docUrl} />
      </React.StrictMode>
    </RepoContext.Provider>
  )
})()
