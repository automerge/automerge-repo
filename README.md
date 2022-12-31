# Automerge Repo

This is a wrapper for the [Automerge](https://github.com/automerge/automerge) CRDT library which provides facilities to support working with many documents at once, as well as pluggable networking and storage.

The core library, [automerge-repo](/packages/automerge-repo/), handles dispatch of events and provides shared functionality such as deciding which peers to connect to or when to write data out to storage.

There is a React-based demonstration application called [automerge-repo-react-demo](/packages/automerge-repo-react-demo/) and a synchronization server under [automerge-repo-sync-server](/packages/automerge-repo-sync-server/). There are example hooks for use with React under [automerge-repo-react-hooks](/packages/automerge-repo-react-hooks/).

These storage adapters are included:

- [automerge-repo-storage-localforage](/packages/automerge-repo-storage-localforage/) - a storage adapter to persist data in a browser
- [automerge-repo-storage-nodefs](/packages/automerge-repo-storage-nodefs/) - a storage adapter to write changes to the filesystem

As well as these network adapters:

- [automerge-repo-network-websocket](/packages/automerge-repo-network-websocket/) - network adapters for both sides of a client/server configuration over websocket
- [automerge-repo-network-localfirstrelay](/packages/automerge-repo-network-localfirstrelay/) a network client that uses [@localfirst/relay](https://github.com/local-first-web/relay) to relay traffic between peers
- [automerge-repo-network-messagechannel](/packages/automerge-repo-network-messagechannel/) - a network adapter that uses the [MessageChannel API](https://developer.mozilla.org/en-US/docs/Web/API/MessageChannel) to communicate between tabs
- [automerge-repo-network-broadcastchannel](/packages/automerge-repo-network-broadcastchannel/) - likely only useful for experimentation, but allows simple (inefficient) tab-to-tab data synchronization

## Usage

There are two main user-facing components: the `Repo` itself, and the `DocHandle`s it contains.

A `Repo` exposes these methods:

- `create<T>()`  
  Creates a new, empty `Automerge.Doc` and returns a `DocHandle` for it.
- `find<T>(docId: DocumentId)`  
  Looks up a given document either on the local machine or (if necessary) over any configured networks.
- `.on("document", ({handle: DocHandle}) => void)`  
  Registers a callback to be fired each time a new document is loaded or created.

A `DocHandle` is a wrapper around an `Automerge.Doc`. Its primary function is to dispatch changes to the document.

- `handle.change((doc: T) => void)` Calls the provided callback with an instrumented mutable object representing the document. Any changes made to the document will be recorded and distributed to other nodes.
- `handle.value()` Returns a `Promise<Doc<T>>` that will contain the current value of the document. it waits until the document has finished loading and/or synchronizing over the network before returning a value.

A `DocHandle` also emits these events:

- `change({handle: DocHandle})`  
  Called any time changes are created or received on the document. Request the `value()` from the handle.
- `patch({handle: DocHandle, before: Doc, after: Doc, patch: Patch})`  
  Useful for manual increment maintenance of a video, most notably for text editors.

## Creating a repo

The repo needs to be configured with storage and network adapters. If you give it neither, it will
still work, but you won't be able to find any data and data created won't outlast the process.

Multiple network adapters (even of the same type) can be added to a repo, even after it is created.

A repo currently only supports a single storage adapter, and it must be provided at creation.

Here is an example of creating a repo with a localforage storage adapter and a broadcast channel network adapter:

```ts
const repo = new Repo({
  network: [new BroadcastChannelNetworkAdapter()],
  storage: new LocalForageStorageAdapter(),
})
```

## Starting the demo app

```bash
yarn
yarn dev
```

## Quickstart

The following instructions will get you a working React app running in a browser.

```bash
yarn create vite
# Project name: hello-automerge-repo
# Select a framework: React
# Select a variant: TypeScript

cd hello-automerge-repo
yarn
yarn add @automerge/automerge automerge-repo automerge-repo-react-hooks automerge-repo-network-broadcastchannel automerge-repo-storage-localforage vite-plugin-wasm vite-plugin-top-level-await
```

Edit the `vite.config.ts`. (This is all need to work around packaging hiccups due to WASM. We look forward to the day that we can delete this step entirely.)

```ts
// vite.config.ts
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import wasm from "vite-plugin-wasm"
import topLevelAwait from "vite-plugin-top-level-await"

export default defineConfig({
  plugins: [wasm(), topLevelAwait(), react()],

  worker: {
    format: "es",
    plugins: [wasm(), topLevelAwait()],
  },

  optimizeDeps: {
    // This is necessary because otherwise `vite dev` includes two separate
    // versions of the JS wrapper. This causes problems because the JS
    // wrapper has a module level variable to track JS side heap
    // allocations, and initializing this twice causes horrible breakage
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

Now set up the repo in `src/main.tsx` by importing the bits, creating the repo, and passing down a
RepoContext. We also create a document and store its `documentId` in localStorage.

```tsx
// src/main.tsx
import React from "react"
import ReactDOM from "react-dom/client"
import App from "./App"
import { Repo } from "automerge-repo"
import { BroadcastChannelNetworkAdapter } from "automerge-repo-network-broadcastchannel"
import { LocalForageStorageAdapter } from "automerge-repo-storage-localforage"
import { RepoContext } from "automerge-repo-react-hooks"

const repo = new Repo({
  network: [new BroadcastChannelNetworkAdapter()],
  storage: new LocalForageStorageAdapter(),
})

let appDocId = localStorage.appDocId
if (!appDocId) {
  const handle = repo.create()
  localStorage.appDocId = appDocId = handle.documentId
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <RepoContext.Provider value={repo}>
    <React.StrictMode>
      <App documentId={appDocId} />
    </React.StrictMode>
  </RepoContext.Provider>
)
```

Now update `App.tsx` to load the document from the Repo based on the documentId passed in. Then, use
the document to render a button that increments the count.

```tsx
// App.tsx
import { useDocument } from "automerge-repo-react-hooks"
import { DocumentId } from "automerge-repo"

interface Doc {
  count: number
}

export function App(props: { documentId: DocumentId }) {
  const [doc, changeDoc] = useDocument<Doc>(props.documentId)

  return (
    <button
      onClick={() => {
        changeDoc((d: any) => {
          d.count = (d.count || 0) + 1
        })
      }}
    >
      count is: {doc?.count ?? 0}
    </button>
  )
}
```

You should now have a working React application using Automerge. Try running it with `yarn dev`, and
open it in two browser windows. You should see the count increment in both windows.

![](/images/hello-automerge-repo.gif)

### Adding a sync server

First, get a sync-server running locally, following the instructions for the [automerge-repo-sync-server](/packages/automerge-repo-sync-server/) package.

Next, update your application to synchronize with it:

Install the websocket network adapter:

```bash
yarn add automerge-repo-network-websocket
```

Now import it and add it to your list of network adapters:

```ts
// main.tsx
import { WebsocketClientNetworkAdapter } from "automerge-repo-network-websocket" // <-- add this line

// ...

const repo = new Repo({
  network: [
    new BroadcastChannelNetworkAdapter(),
    new WebsocketClientNetworkAdapter("wss://localhost:3000"), // <-- add this line
  ],
  storage: new LocalForageStorageAdapter(),
})

// ...
```

And you're finished! You can test that your sync server is opening the same document in two different browsers. (Note that with our current trivial implementation you'll need to manually copy the `appDocId` value between the browsers.)

## Acknowledgements

Originally authored by Peter van Hardenberg. Thanks to Herb Caudill and Jeremy Rose for their contributions to this repo.
