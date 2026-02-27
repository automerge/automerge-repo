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
import React, { Suspense } from "react"
import { ErrorBoundary } from "react-error-boundary"
import ReactDOM from "react-dom/client"
import { App } from "./App.js"
import { State } from "./types.js"
import "./index.css"

// Initialize subduction module references (must be done before using SubductionStorageBridge)
initSubductionModule(subductionModule)
;(async () => {
  const signer = await WebCryptoSigner.setup()
  const storageAdapter = new IndexedDBStorageAdapter("automerge-repo-demo-todo")
  const storage = new SubductionStorageBridge(storageAdapter)
  const subduction = await Subduction.hydrate(signer, storage)

  // Connect to Subduction server via discovery
  const conn = await SubductionWebSocket.tryDiscover(
    new URL("ws://localhost:8080"),
    // new URL("wss://hel.subduction.keyhive.org"),
    signer
  )
  await subduction.attach(conn)
  const repo = new Repo({ subduction })

  const rootDocUrl = `${document.location.hash.substring(1)}`
  let handle
  if (isValidAutomergeUrl(rootDocUrl)) {
    handle = await repo.find(rootDocUrl)
  } else {
    handle = repo.create<State>({ todos: [] })
  }
  const docUrl = (document.location.hash = handle.url)

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
})()
