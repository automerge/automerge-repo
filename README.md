# Automerge-Repo

This repository contains Automerge-Repo, a wrapper for the Automerge CRDT library which provides facilities to support working with many documents at once, as well as pluggable networking and storage.

The core repo, `automerge-repo` handles dispatch of events and provides shared functionality such as deciding which peers to connect to or when to write data out to storage.

There is a React-based demonstration application called `automerge-repo-react-demo` and a synchronization server under `automerge-repo-sync-server`. There are example "hooks" for use with react under `automerge-repo-react-hooks`.

There are a number of additional submodules providing either networking or storage support for various deployment scenarios, including:

 * automerge-repo-storage-localforage - a storage adapter to persist data in a browser
 * automerge-repo-storage-nodefs - a storage adapter to write changes to a unix filesystem
 * automerge-repo-network-websocket - network adapters for both sides of a client/server configuration over websocket
 * automerge-repo-network-localfirst-relay - a network client that uses @localfirst/relay to relay traffic between  peers
 * automerge-repo-network-broadcastchannel - an in-browser / between tabs communication system useful for demos or to keep multiple tabs in sync

All of these are found in `packages`.

## Starting the demo app

```
$ yarn
$ yarn dev
```

## Quickstart to build your own application

# Automerge-Repo

Automerge-Repo is a batteries-included framework for taking advantage of the power of Automerge to build local-first web applications.

It includes a wide variety of integrations, such as with frameworks like React, as well as the infrastructure for a client-server deployment.

# Quick Start

# Getting started with Automerge-Repo

```
$ yarn create vite
// react / Typescript
$ yarn add @automerge/automerge automerge-repo automerge-repo-react-hooks automerge-repo-network-broadcastchannel automerge-repo-storage-localforage vite-plugin-wasm vite-plugin-top-level-await

```

Edit the `vite.config.js`

```
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import wasm from "vite-plugin-wasm"
import topLevelAwait from "vite-plugin-top-level-await"

export default defineConfig({
  plugins: [
    wasm(),
    topLevelAwait(),
    react(),
  ],

  worker: {
    format: "es",
    plugins: [wasm(), topLevelAwait()],
  },

  optimizeDeps: {
    // This is necessary because otherwise `vite dev` includes two separate
    // versions of the JS wrapper. This causes problems because the JS
    // wrapper has a module level variable to track JS side heap
    // allocations, initializing this twice causes horrible breakage
    exclude: [
      "@automerge/automerge-wasm",
      "@automerge/automerge-wasm/bundler/bindgen_bg.wasm",
      "@syntect/wasm",
    ],
  },

  server: {
    fs: {
      strict: false,
    },
  },
})
```

Now set up the repo in `main.tsx` by importing the bits, creating the repo, and passing down a RepoContext.

We also create a document and store the `documentId` in localStorage.

```
import { Repo } from "automerge-repo"
import { BroadcastChannelNetworkAdapter } from "automerge-repo-network-broadcastchannel"
import { LocalForageStorageAdapter } from "automerge-repo-storage-localforage"
import { RepoContext } from "automerge-repo-react-hooks"

const repo = new Repo({
  network: [new BroadcastChannelNetworkAdapter()],
  storage: new LocalForageStorageAdapter()
})

let appDocId = localStorage.appDocId
if (!appDocId) {
  const handle = repo.create()
  localStorage.appDocId = appDocId = handle.documentId
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <RepoContext.Provider value={repo}>
    <React.StrictMode>
      <App documentId={appDocId}/>
    </React.StrictMode>
  </RepoContext.Provider>
)

```

And last update `App.tsx` to use the documentId passed in. 

First, load the document from the Repo based on the documentId passed in.

```
import { useDocument } from 'automerge-repo-react-hooks'
import { DocumentId } from 'automerge-repo'

interface Doc {
  count: number
}

function App(props: { documentId: DocumentId }) {
  const [doc, changeDoc] = useDocument<Doc>(props.documentId)

```

Then, use the document:

```
        <button onClick={() => { changeDoc( (d: any) => {
              d.count = (d.count || 0) + 1
          })}}>
          count is: {doc?.count}
        </button>
```

From here, you have a bonafide Automerge-based React application. You'll probably want to add a sync server next.

First, get a sync-server running locally (via the instructions found in the [packages/automerge-repo-sync-server] directory.)

Next, update your application to synchronize with it.

Install and import the package.

```
$ yarn add automerge-repo-network-websocket
```

```
import { WebsocketClientNetworkAdapter } from "automerge-repo-network-websocket"
```

Now edit your list of network adapters to point to include the sync server:

```
network: [new BroadcastChannelNetworkAdapter(), new WebsocketClientNetworkAdapter("wss://localhost:3000")]
```

And you're finished! You can test that your sync server is opening the same document in two different browsers. (Note that with our current trivial implementation you'll need to manually copy the `appDocId` value between the browsers.)

## Acknowledgements

Originally authored by Peter van Hardenberg. Thanks to Herb Caudill and Jeremy Rose for their contributions to this repo.
