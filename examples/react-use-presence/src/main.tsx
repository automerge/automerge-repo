import React from "react"
import ReactDOM from "react-dom/client"
import { App } from "./App"
import {
  Repo,
  isValidAutomergeUrl,
  BroadcastChannelNetworkAdapter,
  IndexedDBStorageAdapter,
  RepoContext,
} from "@automerge/react"

const repo = new Repo({
  storage: new IndexedDBStorageAdapter("use-awareness-example"),
  network: [new BroadcastChannelNetworkAdapter()],
})

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
      <App url={docUrl} />
    </React.StrictMode>
  </RepoContext.Provider>
)
