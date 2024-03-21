# React Hooks for Automerge Repo

These hooks are provided as helpers for using Automerge in your React project.

#### [useBootstrap](./src/useBootstrap.ts)

This hook is used to load a document based on the URL hash, for example `//myapp/#documentId=[document ID]`.
It can also create a new document if none is specified.

#### [useLocalAwareness](./src/useLocalAwareness.ts) & [useRemoteAwareness](./src/useRemoteAwareness.ts)

These hooks implement ephemeral awareness/presence, similar to [Yjs Awareness](https://docs.yjs.dev/getting-started/adding-awareness).
They allow temporary state to be shared, such as cursor positions or peer online/offline status.

Ephemeral messages are replicated between peers, but not saved to the Automerge doc, and are used for temporary updates that will be discarded.

#### [useRepo/RepoContext](./src/useRepo.ts)

Use RepoContext to set up react context for an Automerge repo.
Use useRepo to lookup the repo from context.
Most hooks depend on RepoContext being available.

#### [useDocument](./src/useDocument.ts)

Return a document & updater fn, by ID.

#### [useHandle](./src/useHandle.ts)

Return a handle, by ID.

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
    network: [new BroadcastChannelNetworkAdapter()],
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
