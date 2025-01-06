import React from "react"
import ReactDOM from "react-dom/client"
import { App } from "./App.js"
import { DocHandle, Repo, isValidAutomergeUrl } from "@automerge/automerge-repo"
import { MessageChannelNetworkAdapter } from "@automerge/automerge-repo-network-messagechannel"
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb"
import { RepoContext } from "@automerge/automerge-repo-react-hooks"

// We run the network & storage in a separate file and the tabs themselves are stateless and lightweight.
// This means we only ever create one websocket connection to the sync server, we only do our writes in one place
// (no race conditions) and we get local real-time sync without the overhead of broadcast channel.
// The downside is that to debug any problems with the sync server you'll need to find the shared-worker and inspect it.
// In Chrome-derived browsers the URL is chrome://inspect/#workers. In Firefox it's about:debugging#workers.
// In Safari it's Develop > Show Web Inspector > Storage > IndexedDB > automerge-repo-demo-counter.

const sharedWorker = new SharedWorker(
  new URL("./shared-worker.ts", import.meta.url),
  {
    type: "module",
    name: "automerge-repo-shared-worker",
  }
)

/* Create a repo and share any documents we create with our local in-browser storage worker. */
const repo = new Repo({
  network: [new MessageChannelNetworkAdapter(sharedWorker.port)],
  storage: new IndexedDBStorageAdapter("automerge-repo-demo-counter"),
  sharePolicy: async peerId => peerId.includes("shared-worker"),
})

declare global {
  interface Window {
    handle: DocHandle<unknown>
    repo: Repo
  }
}

const rootDocUrl = `${document.location.hash.substring(1)}`
let handle
if (isValidAutomergeUrl(rootDocUrl)) {
  handle = await repo.find(rootDocUrl)
} else {
  handle = repo.create<{ count: number }>({ count: 0 })
}
const docUrl = (document.location.hash = handle.url)
window.handle = handle // we'll use this later for experimentation
window.repo = repo

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <RepoContext.Provider value={repo}>
    <React.StrictMode>
      <App url={docUrl} />
    </React.StrictMode>
  </RepoContext.Provider>
)
