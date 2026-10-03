import {
  Repo,
  RepoContext,
  createSubductionPeer,
  IndexedDBByteStore,
  isValidAutomergeUrl,
  type DocHandle,
} from "@automerge/react"

import React, { Suspense } from "react"
import { ErrorBoundary } from "react-error-boundary"
import ReactDOM from "react-dom/client"
import { App } from "./App.js"
import { State } from "./types.js"
import "./index.css"

const server = new URL(
  new URLSearchParams(location.search).get("server") ??
    "wss://subduction.sync.inkandswitch.com"
)
const storage = new IndexedDBByteStore({ database: "automerge-repo-demo-todo" })
const peer = createSubductionPeer({
  storage,
  servers: [{ url: server, serviceName: server.host }],
})
const repo = new Repo({ backend: peer.backend })

declare global {
  interface Window {
    handle: DocHandle<unknown>
    repo: Repo
  }
}

const rootDocUrl = `${document.location.hash.substring(1)}`
let handle: DocHandle<State>
if (isValidAutomergeUrl(rootDocUrl)) {
  handle = await repo.find<State>(rootDocUrl)
} else {
  handle = await repo.create<State>({ todos: [] })
}
const docUrl = (document.location.hash = handle.url)
window.handle = handle // we'll use this later for experimentation
window.repo = repo

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    void (async () => {
      try {
        await repo.shutdown()
      } finally {
        try {
          await peer.close()
        } finally {
          await storage.close()
        }
      }
    })().catch(console.error)
  })
}

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
