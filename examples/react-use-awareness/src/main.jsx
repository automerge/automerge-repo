import React from "react"
import ReactDOM from "react-dom/client"
import { App } from "./App"
import { Repo, isValidAutomergeUrl } from "@automerge/automerge-repo"
import { BroadcastChannelNetworkAdapter } from "@automerge/automerge-repo-network-broadcastchannel"
import { RepoContext } from "@automerge/automerge-repo-react-hooks"
import { v4 } from "uuid"
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb"

const repo = new Repo({
  storage: new IndexedDBStorageAdapter("use-awareness-example"),
  network: [new BroadcastChannelNetworkAdapter()],
})

const userId = v4()

const rootDocUrl = `${document.location.hash.substring(1)}`
const handle = isValidAutomergeUrl(rootDocUrl)
  ? repo.find(rootDocUrl)
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
