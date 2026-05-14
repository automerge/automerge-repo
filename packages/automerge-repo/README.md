# Automerge Repo

This is a wrapper for the [Automerge](https://github.com/automerge/automerge) CRDT library which
provides facilities to support working with many documents at once, as well as pluggable networking
and storage.

This is the core library. It handles dispatch of events and provides shared functionality such as
deciding which peers to connect to or when to write data out to storage.

Other packages in this monorepo include:

- [@automerge/automerge-repo-demo-counter](/packages/automerge-repo-demo-counter/): A React-based demonstration
  application.
- [@automerge/automerge-repo-react-hooks](/packages/automerge-repo-react-hooks/): Example hooks for use with
  React.

#### Storage adapters

- [@automerge/automerge-repo-storage-indexeddb](/packages/automerge-repo-storage-indexeddb/): A storage
  adapter to persist data in a browser
- [@automerge/automerge-repo-storage-nodefs](/packages/automerge-repo-storage-nodefs/): A storage adapter to
  write changes to the filesystem

#### Network adapters

- [@automerge/automerge-repo-network-websocket](/packages/automerge-repo-network-websocket/): Network adapters
  for both sides of a client/server configuration over websocket
- [@automerge/automerge-repo-network-messagechannel](/packages/automerge-repo-network-messagechannel/): A
  network adapter that uses the [MessageChannel
  API](https://developer.mozilla.org/en-US/docs/Web/API/MessageChannel) to communicate between tabs
- [@automerge/automerge-repo-network-broadcastchannel](/packages/automerge-repo-network-broadcastchannel/):
  Likely only useful for experimentation, but allows simple (inefficient) tab-to-tab data
  synchronization

## Usage

This library provides two main components: the `Repo` itself, and the `DocHandle`s it contains.

A `Repo` exposes these methods:

- `create<T>(initialValue: T?)`
  Creates a new `Automerge.Doc` and returns a `DocHandle` for it. Accepts an optional initial value for the document. Produces an empty document (potentially violating the type!) otherwise.
- `find<T>(docId: DocumentId): Promise<DocHandle<T>>`  
  Looks up a given document either on the local machine or (if necessary) over any configured
  networks. Returns a promise that resolves when the document is loaded or throws if load fails.
- `delete(docId: DocumentId)`  
  Deletes the local copy of a document from the local cache and local storage. _This does not currently delete the document from any other peers_.
- `import(binary: Uint8Array)`  
  Imports a document binary (from `export()` or `Automerge.save(doc)`) into the repo, returning a new handle
- `export(docId: DocumentId)`  
  Exports the document. Returns a Promise containing either the Uint8Array of the document or undefined if the document is currently unavailable. See the [Automerge binary format spec](https://automerge.org/automerge-binary-format-spec/) for more details on the shape of the Uint8Array.
- `.on("document", ({handle: DocHandle}) => void)`  
  Registers a callback to be fired each time a new document is loaded or created.
- `.on("delete-document", ({handle: DocHandle}) => void)`  
  Registers a callback to be fired each time a new document is deleted.

A `DocHandle` is a wrapper around an `Automerge.Doc`. Its primary function is to dispatch changes to
the document.

- `handle.doc()`
  Returns a `Doc<T>` that will contain the current value of the document.
  Throws an error if the document is deleted.
- `handle.change((doc: T) => void)`  
  Calls the provided callback with an instrumented mutable object
  representing the document. Any changes made to the document will be recorded and distributed to
  other nodes.

A `DocHandle` also emits these events:

- `change({handle: DocHandle, patches: Patch[], patchInfo: PatchInfo})`
  Called whenever the document changes, the handle's .doc
- `delete`  
  Called when the document is deleted locally.

## Creating a repo

The repo needs to be configured with storage and network adapters. If you give it neither, it will
still work, but you won't be able to find any data and data created won't outlast the process.

Multiple network adapters (even of the same type) can be added to a repo, even after it is created.

A repo currently only supports a single storage adapter, and it must be provided at creation.

Here is an example of creating a repo with a indexeddb storage adapter and a broadcast channel
network adapter:

```ts
const repo = new Repo({
  network: [new BroadcastChannelNetworkAdapter()],
  storage: new IndexedDBStorageAdapter(),
  sharePolicy: async (peerId: PeerId, documentId: DocumentId) => true, // this is the default
})
```

### Share Policy

The share policy is used to determine which document in your repo should be _automatically_ shared with other peers. **The default setting is to share all documents with all peers.**

> **Warning**
> If your local repo has deleted a document, a connecting peer with the default share policy will still share that document with you.

You can override this by providing a custom share policy. The function should return a promise resolving to a boolean value indicating whether the document should be shared with the peer.

The share policy will not stop a document being _requested_ by another peer by its `DocumentId`.

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
yarn add @automerge/automerge @automerge/automerge-repo-react-hooks @automerge/automerge-repo-network-broadcastchannel @automerge/automerge-repo-storage-indexeddb vite-plugin-wasm
```

Edit the `vite.config.ts`. (This is all needed to work around packaging hiccups due to WASM. We look
forward to the day that we can delete this step entirely.)

```ts
// vite.config.ts
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import wasm from "vite-plugin-wasm"

export default defineConfig({
  plugins: [wasm(), react()],

  worker: {
    format: "es",
    plugins: () => [wasm()],
  },
})
```

Now set up the repo in `src/main.tsx` by importing the bits, creating the repo, and passing down a
RepoContext. We also create a document and store its `documentId` in localStorage.

```tsx
// src/main.tsx
import React from "react"
import ReactDOM from "react-dom/client"
import App from "./App.js"
import { Repo } from "@automerge/automerge-repo"
import { BroadcastChannelNetworkAdapter } from "@automerge/automerge-repo-network-broadcastchannel"
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb"
import { RepoContext } from "@automerge/automerge-repo-react-hooks"

const repo = new Repo({
  network: [new BroadcastChannelNetworkAdapter()],
  storage: new IndexedDBStorageAdapter(),
})

let rootDocId = localStorage.rootDocId
if (!rootDocId) {
  const handle = repo.create()
  localStorage.rootDocId = rootDocId = handle.documentId
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <RepoContext.Provider value={repo}>
    <React.StrictMode>
      <App documentId={rootDocId} />
    </React.StrictMode>
  </RepoContext.Provider>
)
```

Now update `App.tsx` to load the document from the Repo based on the documentId passed in. Then, use
the document to render a button that increments the count.

```tsx
// App.tsx
import { useDocument } from "@automerge/automerge-repo-react-hooks"
import { DocumentId } from "@automerge/automerge-repo"

interface Doc {
  count: number
}

export default function App(props: { documentId: DocumentId }) {
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

This application is also available as a package in this repo in
[automerge-repo-demo-counter](/packages/automerge-repo-demo-counter). You can run it with `yarn
dev:demo`.

### Adding a sync server

First, get a sync-server running locally, following the instructions for the
[automerge-repo-sync-server](https://github.com/automerge/automerge-repo-sync-server) package.

Next, update your application to synchronize with it:

Install the websocket network adapter:

```bash
yarn add automerge-repo-network-websocket
```

Now import it and add it to your list of network adapters:

```ts
// main.tsx
import { WebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket" // <-- add this line

// ...

const repo = new Repo({
  network: [
    new BroadcastChannelNetworkAdapter(),
    new WebSocketClientAdapter("ws://localhost:3030"), // <-- add this line
  ],
  storage: new IndexedDBStorageAdapter(),
})

// ...
```

And you're finished! You can test that your sync server is opening the same document in two
different browsers (e.g. Chrome and Firefox). (Note that with our current trivial implementation
you'll need to manually copy the `rootDocId` value between the browsers.)

## Memory lifetime — consumer responsibilities

`Repo` follows consumer lifetime decisions: if you hold a strong reference to a `DocHandle`, the repo keeps it alive; if you drop the reference and the handle becomes garbage-collectable, the repo automatically releases the associated coordination state (synchronizer entry, sync info).

### The contract

- **Holding a strong reference keeps the document loaded.** Storage backing, sync state, and the synchronizer entry stay alive as long as your reference does.
- **Dropping the reference releases everything.** Once garbage collection reclaims the handle, the repo's internal storage and the per-document synchronizer entry are cleaned up automatically. No call to `repo.removeFromCache(id)` is required.
- **A consumer-side `WeakMap<DocHandle, ...>` for derived state works as expected.** The repo no longer pins the handle, so weak-map entries are released when you drop your reference.

**Opt-in modules with their own teardown.** The contract above covers the `Repo` / `DocHandle` reference relationship. Some optional modules layer their own long-lived state on top of a handle — most notably [`Presence`](src/presence/Presence.ts), which schedules heartbeat and peer-pruning intervals in the host timer queue. The timer queue is an external GC root that keeps the `Presence` (and its handle) alive until cleared, so dropping references is **not** enough for those: call `presence.stop()` deterministically (typically in a `pagehide` / unmount path) before releasing. See the relevant module's docs for the specifics.

### Flush unsaved changes before dropping

Pending throttled saves keep the handle alive briefly via the timer queue, so they always reach storage. But if you need a deterministic point at which all writes are persisted, `await repo.flush(documentId)` first:

```ts
await repo.flush(handle.documentId) // ensure pending changes hit storage
handle = null // drop the reference; GC will follow when ready
```

### `removeFromCache` is for explicit teardown

`repo.removeFromCache(documentId)` is still available. Its semantics changed from "force-clean the entry" to "force-clean _now_ instead of waiting for GC." Use it when you need synchronous teardown (e.g. shutting down a subsystem with a known doc list); for typical reference-dropping patterns it is no longer needed.

### Consumer-managed LRU (sync servers, long-running processes)

`Repo` does not include a built-in LRU or grace-period cache. The right level for these policies is the consumer: you know your access pattern, your eviction criterion (time, count, memory pressure), and your tolerance for re-loading on the next access.

A consumer LRU is just a strong-reference map under your own policy. When a handle should be evicted, drop the reference — the repo follows:

```ts
class HandleLRU<T> {
  #strong = new Map<DocumentId, DocHandle<T>>() // strong refs, your LRU policy
  // ... your own eviction logic (time, count, memory) ...

  evict(documentId: DocumentId) {
    this.#strong.delete(documentId)
    // No removeFromCache call needed: dropping the strong reference is enough.
    // The repo releases coordination state when GC reclaims the handle.
  }
}
```

### Behavior change vs. previous versions

In earlier versions, `Repo` strongly retained every handle it created for the lifetime of the `Repo`. Consumers needed `removeFromCache(id)` for every doc they wanted to release. Code that relied on that retention (e.g. assuming a previously-`find()`-ed handle would still be in the cache without holding the reference yourself) needs review.

For most application code the change is transparent — you were already holding handles where you needed them. The change affects code that _implicitly_ relied on the repo as a permanent cache.

## Acknowledgements

Originally authored by Peter van Hardenberg.

With gratitude for contributions by:

- Herb Caudill
- Jeremy Rose
- Alex Currie-Clark
- Dylan Mackenzie
- Maciek Sakrejda
- George Su
- Neftaly Hernandez
- Bijela Gora
- Mykola Veremchuk
- Blaine Cook
