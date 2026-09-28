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

`handle.off(event)` and `handle.removeAllListeners()` do not remove the listeners the repo itself attaches for storage autosave, query updates and sync, so the document keeps saving and syncing. Listeners attached on your behalf, by `Presence` or by `subscribe`/`whenReady` on a `findWithProgress` result for a URL with heads, are removed along with your own.

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

## Logging

`automerge-repo` routes all of its output (trace, info, warnings, errors) through a single `Logger` interface. The default writes `.debug` through the [`debug`](https://www.npmjs.com/package/debug) package and the other levels through `console`, prefixed with the subsystem namespace (e.g. `[automerge-repo:repo]`).

Trace output is silent unless you opt in:

```bash
DEBUG=automerge-repo:* node ./your-app.js
```

To route output through your own logger (winston, pino, bunyan, etc.), call `setLoggerFactory` once at startup:

```ts
import { setLoggerFactory } from "@automerge/automerge-repo"
import winston from "winston"

const logger = winston.createLogger({
  /* ... */
})

setLoggerFactory(namespace => ({
  debug: (msg, ...args) => logger.debug(msg, { namespace, args }),
  info: (msg, ...args) => logger.info(msg, { namespace, args }),
  warn: (msg, ...args) => logger.warn(msg, { namespace, args }),
  error: (msg, ...args) => logger.error(msg, { namespace, args }),
}))
```

The factory is called once per subsystem instance with a namespace such as `automerge-repo:repo`, `automerge-repo:docsync:abc12`, or `automerge-repo:storage-subsystem`.

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

## Memory lifetime

`Repo` keeps a document loaded while you observe it: while you hold a strong reference to a `DocHandle` (or a `DocumentProgress`), or keep a listener attached. Once nothing observes it, the `releaseUnobservedAfterMs` setting decides when the repo lets it go, and the repo then releases the associated coordination state (query, synchronizer entry, sync info, save listener).

### The contract

- **Holding a strong reference keeps the document loaded.** Storage backing, sync state, and the synchronizer entry stay alive as long as your reference does.
- **An attached listener also keeps it loaded.** `handle.on(...)` (and an active `DocumentProgress.subscribe(...)` or a pending `whenReady`) roots the document in the repo, so events keep flowing even if you drop the handle itself. Remove the listener (`off`, `removeAllListeners`, the unsubscribe function) to release that root. A listener you never remove pins its document for the life of the `Repo`.
- **Public listener removal is safe cleanup.** `off(event)` and `removeAllListeners()` release the retention held by the listeners you added. The repo's own listeners (storage autosave, query updates, sync) stay attached, so sweeping a handle's listeners does not stop the document saving or syncing for other consumers.
- **An unobserved document is released after a period without activity.** `releaseUnobservedAfterMs` (see Settings) sets the period. The document reloads on next use; no `repo.removeFromCache(id)` call is needed.
- **In-memory peer sync info lives with the document.** `handle.getSyncInfo(storageId)` reports what this process has learned since the document was last loaded; after the document is released and re-loaded it returns `undefined` until fresh sync messages arrive, just as it does after a process restart. After a reload the repo resumes syncing with peers it synced with before (from persisted sync state) and with connected peers that asked for the document.
- **A consumer-side `WeakMap<DocHandle, ...>` for derived state works as expected.** Its entries go when the repo releases the document, so after the release period once you drop your references.

**Opt-in modules with their own teardown.** Some optional modules layer their own long-lived state on top of a handle, most notably [`Presence`](src/presence/Presence.ts), which schedules heartbeat and peer-pruning intervals in the host timer queue. The timer queue is an external GC root that keeps the `Presence` (and its handle) alive until cleared, so dropping references is **not** enough for those: call `presence.stop()` deterministically (typically in a `pagehide` / unmount path) before releasing. See the relevant module's docs for the specifics.

### Settings

| Option                     | Default                                   | Meaning                                                                                                                                                                                     |
| -------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `releaseUnobservedAfterMs` | `30_000` with storage, `Infinity` without | How long an unobserved document stays loaded after its last activity. `0` releases it once it is unobserved; `Infinity` never releases it.                                                  |
| `maxUnobservedBytes`       | `Infinity`                                | Cap on the stored size of the documents the release setting keeps (documents with a listener attached are not counted). The least recently active go first. Takes effect only with storage. |
| `retainUntilSaved`         | `false`                                   | Keep a document whose save failed until a save at its current heads succeeds.                                                                                                               |
| `maxPinnedRequestsPerPeer` | `1000`                                    | How many documents one peer's unanswered requests can keep loaded while this repo asks other peers for them (about 16 MB per peer at the default). `Infinity` disables the cap.             |

Recommended:

- **Apps:** hold handles where you use them (framework hooks do this for you) and keep the defaults.
- **Sync servers:** keep the default release period, which keeps documents loaded between editing bursts instead of reloading them each time, and set `maxUnobservedBytes` to bound memory. It counts stored (compressed) bytes, and a loaded document takes more memory than its stored size, so size it from your own measurements.
- **Repos without storage:** the default never releases, since the repo may hold the only copy. Release documents yourself with `removeFromCache`, or set a finite period only if another peer holds your data.
- **`retainUntilSaved`:** enable it only if your storage recovers from failures; until it does, those documents stay in memory. Without it, unsaved changes survive a storage failure only on peers that synced them.

For a policy of your own (by count, time or memory), hold the handles yourself in a map under your eviction rule and set `releaseUnobservedAfterMs: 0`.

### Flush unsaved changes before dropping

A pending throttled save keeps the document loaded until the write finishes. A failed save is logged, and the change then lives only in memory (see `retainUntilSaved`) or on peers that synced it. If you need a deterministic point at which all writes are persisted, `await repo.flush([documentId])` first:

```ts
await repo.flush([handle.documentId]) // ensure pending changes hit storage
handle = null // drop the reference; the repo releases the document after the release period
```

### `removeFromCache` is for explicit teardown

`repo.removeFromCache(documentId)` releases a document at once, whatever the settings above; `repo.delete(documentId)` does too, and also deletes it. Both sever listener-based rooting, so a document you tear down explicitly is released even if some listener was never removed. Use them when you need synchronous teardown (e.g. shutting down a subsystem with a known doc list); for typical reference-dropping patterns they are not needed.

### Behavior change vs. previous versions

In earlier versions, `Repo` strongly retained every handle it created for the lifetime of the `Repo`. A repo without storage still does by default. A repo with storage now releases an unobserved document after the release period and reloads it on next use; set `releaseUnobservedAfterMs: Infinity` to keep the old behavior.

For most application code the change is transparent: you were already holding handles or listening where you needed them. The change affects code that _implicitly_ relied on the repo as a permanent cache.

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
