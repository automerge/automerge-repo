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
import { initSync } from "@automerge/automerge-subduction/slim"
import * as subductionModule from "@automerge/automerge-subduction/slim"
import {
  Subduction,
  WebCryptoSigner,
} from "@automerge/automerge-subduction/slim"
import { wasmBase64 } from "@automerge/automerge-subduction/wasm-base64"
import React, { Suspense } from "react"
import { ErrorBoundary } from "react-error-boundary"
import ReactDOM from "react-dom/client"
import { App } from "./App.js"
import { State } from "./types.js"
import "./index.css"

// Initialize Subduction Wasm from base64 (use /slim to avoid bundler.js dual-module class identity issue)
initSync(Uint8Array.from(atob(wasmBase64), c => c.charCodeAt(0)))
initSubductionModule(subductionModule)
;(async () => {
  const signer = await WebCryptoSigner.setup()
  const storageAdapter = new IndexedDBStorageAdapter("automerge-repo-demo-todo")
  const storage = new SubductionStorageBridge(storageAdapter)
  const subduction = await Subduction.hydrate(signer, storage)
  await subduction.connectDiscover(new URL("ws://localhost:8080"))
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
