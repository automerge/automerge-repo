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

## Using Automerge-Repo

There are two main user-facing components of automerge repo. The `Repo` itself, and the `DocHandles` it contains.

Repo has only two main methods a user should interact with:

* create<T>(): returns a DocHandle for a new, empty document and
* find<T>(docId: DocumentId): which looks up a given document either on the local machine or (if necessary) over any configured networks.
* .on("document", ({handle: DocHandle}) => void): an event is emitted every time a new document is loaded or created

A DocHandle is a wrapper around an Automerge.Doc primarily to handle event dispatch and is similarly straightforward.

* handle.value(): returns a Promise<Doc<T>> that will contain the current value of the document. it waits until the document has finished loading and/or synchronizing over the network before returning a value.
* handle.change( (d: T) => void ): calls the provided callback with an instrumented mutable object representing the document. Any changes made to the document will be recorded and distributed to other nodes.
  
Last, DocHandles also emit two useful events:
* change({handle: DocHandle}): called any time changes are created or received on the document. request the value() from the handle
* patch({handle: DocHandle, before: Doc, after: Doc, patch: Patch}): useful for manual increment maintenance of a video, most notably for text editors

  
## Creating an Automerge Repo

To make use of Automerge-Repo, you should configure it with Storage and Network. If you give it neither, it will still work, but you won't be able to find any data and data created won't outlast the process.

Note that we currently only support one Storage per repo, and it must be provided at creation. Many network adapters (even of the same type) can be added, even after the repository is created.

A config example is given below, but for storage the team provides two options out of the box.
  * automerge-repo-storage-localforage: a simple wrapper around an IndexedDb library
  * automerge-repo-storage-nodefs: a wrapper for storing data in a subfolder

There are three primary networking options supported:
  * automerge-repo-network-websocket: for client-server applications (see also automerge-repo-sync-server)
  * automerge-repo-network-messagechannel: for intra-browser communication (useful for synchronizing tabs with shared workers or service workers)
  * automerge-repo-network-broadcastchannel: likely only useful for experimentation, but allows simple (inefficient) tab-to-tab data synchronization


For example:

```
const repo = new Repo({
  network: [new BroadcastChannelNetworkAdapter()],
  storage: new LocalForageStorageAdapter()
})
```

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

Edit the `vite.config.js`. 

(Every part of what you're adding here is working around packaging hiccups due to WASM. We look forward to the day that we can delete this step entirely.)

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
