import { DocHandle, Repo, isValidAutomergeUrl } from "@automerge/automerge-repo"
import { BroadcastChannelNetworkAdapter } from "@automerge/automerge-repo-network-broadcastchannel"
import { WebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket"
import { RepoContext } from "@automerge/automerge-repo-react-hooks"
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb"
import React, { Suspense } from "react"
import { ErrorBoundary } from "react-error-boundary"
import ReactDOM from "react-dom/client"
import { App } from "./App.js"
import { State } from "./types.js"
import { connectClientWebsocket } from "@automerge/beelay-network-websocket"
import "./index.css"

const repo = new Repo({
  network: [new BroadcastChannelNetworkAdapter()],
  storage: new IndexedDBStorageAdapter("automerge-repo-demo-todo"),
})

console.log("getting the beelay")
const beelay = await repo.beelay()
console.log("got the beelay")
connectClientWebsocket(beelay, "ws://localhost:3030/beelay")
await new Promise(resolve => setTimeout(resolve, 1000))

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
  handle = await repo.create<State>({ todos: [] })
}
const docUrl = (document.location.hash = handle.url)
window.handle = handle // we'll use this later for experimentation
window.repo = repo

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <RepoContext.Provider value={repo}>
    <React.StrictMode>
      <ErrorBoundary fallback={<div>Something went wrong</div>}>
        <Suspense fallback={<div>Loading...</div>}>
          <App url={docUrl} />
        </Suspense>
      </ErrorBoundary>
    </React.StrictMode>
  </RepoContext.Provider>
)
