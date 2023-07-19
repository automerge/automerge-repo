# React Hooks for Automerge Repo

## Example usage

### App Setup

```ts
import React, { StrictMode } from "react"
import ReactDOM from "react-dom/client"

import { Repo, DocCollection } from "@automerge/automerge-repo"

import { BroadcastChannelNetworkAdapter } from "@automerge/automerge-repo-network-broadcastchannel"

import App, { RootDocument } from "./App.js"
import { RepoContext } from "@automerge/automerge-repo-react-hooks"

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const sharedWorker = new SharedWorker(
  new URL("./shared-worker.js", import.meta.url),
  { type: "module", name: "@automerge/automerge-repo-shared-worker" }
)

async function getRepo(): Promise<DocCollection> {
  return await Repo({
    network: [
      new BroadcastChannelNetworkAdapter(),
    ],
    sharePolicy: peerId => peerId.includes("shared-worker"),
  })
}

const initFunction = (d: RootDocument) => {
  d.items = []
}

const queryString = window.location.search // Returns:'?q=123'

// Further parsing:
const params = new URLSearchParams(queryString)
const hostname = params.get("host") || "automerge-storage-demo.glitch.me"

getRepo().then(repo => {
  useBootstrap(repo, initFunction).then(rootDoc => {
    const rootElem = document.getElementById("root")
    if (!rootElem) {
      throw new Error("The 'root' element wasn't found in the host HTML doc.")
    }
    const root = ReactDOM.createRoot(rootElem)
    root.render(
      <StrictMode>
        <RepoContext.Provider value={repo}>
          <App rootDocumentId={rootDoc.documentId} />
        </RepoContext.Provider>
      </StrictMode>
    )
  })
})
```
