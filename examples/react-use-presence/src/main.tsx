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
import { IndexedDbStorage, Subduction } from "@automerge/automerge_subduction"
import { v4 } from "uuid"
;(async () => {
  const db = await IndexedDbStorage.setup(indexedDB)
  const repo = new Repo({
    network: [new WebSocketClientAdapter("ws://127.0.0.1:8080", 5000, { subductionMode: true })],
    subduction: await Subduction.hydrate(db),
  })

  const userId = v4()

  const rootDocUrl = `${document.location.hash.substring(1)}`
  const handle = isValidAutomergeUrl(rootDocUrl)
    ? await repo.find(rootDocUrl)
    : repo.create()

  const docUrl = (document.location.hash = handle.url)

  window.handle = handle // we'll use this later for experimentation
  window.repo = repo

  ReactDOM.createRoot(document.getElementById("root")).render(
    <RepoContext.Provider value={repo}>
      <React.StrictMode>
        <App userId={userId} url={docUrl} />
      </React.StrictMode>
    </RepoContext.Provider>
  )
})()
