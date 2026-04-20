import React from "react"
import ReactDOM from "react-dom/client"
import { App } from "./App"
import {
  Repo,
  isValidAutomergeUrl,
  IndexedDBStorageAdapter,
  RepoContext,
} from "@automerge/react"
// @ts-ignore — initSync is not in the type declarations but is exported at runtime
import { initSync } from "@automerge/automerge-subduction/slim"
// @ts-ignore — wasm-base64 has no type declarations
import { wasmBase64 } from "@automerge/automerge-subduction/wasm-base64"

// Initialize Subduction Wasm before constructing the Repo
initSync({ module: Uint8Array.from(atob(wasmBase64), c => c.charCodeAt(0)) })

const repo = new Repo({
  storage: new IndexedDBStorageAdapter("use-awareness-example"),
  subductionWebsocketEndpoints: ["wss://subduction.sync.inkandswitch.com"],
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
