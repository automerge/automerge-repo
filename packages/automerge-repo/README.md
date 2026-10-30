# Automerge Repo

A wrapper for the [Automerge](https://github.com/automerge/automerge) CRDT library which
supports working with many documents at once, with pluggable persistence and synchronization.

> **Alpha.** This is not yet ready for use in production

## Quick Start

```ts
import "@automerge/subduction" // initializes Subduction's WASM
import { Repo } from "@automerge/automerge-repo"
import { SubductionBackend } from "@automerge/automerge-repo-subduction"
import { IndexedDBSubductionStorageAdapter } from "@automerge/automerge-repo-subduction-storage-indexeddb"
import { WebSocketSubductionNetworkAdapter } from "@automerge/automerge-repo-subduction-network-websocket"

const storage = new IndexedDBSubductionStorageAdapter()
const backend = new SubductionBackend({
  storage,
  network: [
    new WebSocketSubductionNetworkAdapter(
      "wss://subduction.sync.inkandswitch.com"
    ),
  ],
})
const repo = new Repo({
  backend,
})

const handle = await repo.create({ count: 0 })
await handle.change(doc => {
  doc.count++
})

const found = await repo.find<{ count: number }>(handle.url)
```

`new Repo()` can function without a backend, but is _local-only_: nothing is stored or synced.

When you are finished, close down the repo. This also closes the backend and flushes any pending writes.

```ts
await repo.shutdown()
await storage.close()
```

See [automerge-repo-subduction](../automerge-repo-subduction/) for backend configuration.

## Breaking Changes from v2

| v2                                                    | v3                                                                                                             |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `new Repo({ network, storage, sharePolicy, ... })`    | `new Repo({ backend })`                                                                                        |
| Network/storage adapter packages                      | Subduction backend with its own storage and network adapters                                                   |
| `sharePolicy`, `shareConfig`, `denylist`              | Removed                                                                                                        |
| `RepoConfig.peerId`, `repo.peerId`                    | `RepoConfig.id`, `repo.id` (a `RepoId`)                                                                        |
| `repo.peers`, `StorageId`                             | Removed                                                                                                        |
| `create()`, `import()`, `clone()` return `DocHandle`  | Return `Promise<DocHandle>`                                                                                    |
| `handle.change()` returns `void`                      | Returns `Promise<void>`, resolving once the edit is stored                                                     |
| `repo.delete()` returns `void`                        | Returns `Promise<void>`                                                                                        |
| `findWithProgress()`                                  | Deprecated; use `query()`                                                                                      |
| `handle.whenReady()`, `inState()`                     | Removed; handles from `find()`/`create()` are always ready                                                     |
| `getRemoteHeads(storageId)`, `getSyncInfo(storageId)` | `getSyncInfo(peerId)`                                                                                          |
| `remote-heads` event's `storageId`                    | `peerId`                                                                                                       |
| `ephemeral-message` event's `senderId`                | `senderId` (authenticated peer) and `originId` (sending Repo)                                                  |
| `doc-metrics` event                                   | Removed                                                                                                        |
| `ephemeral-message-outbound` event                    | Removed                                                                                                        |
| `Presence` keyed by peer ID                           | Keyed by `originId`                                                                                            |
| 16-byte document IDs                                  | 32-byte; old URLs still open; convert IDs with `normalizeDocumentId`                                           |
| Failed saves logged; included in the next save        | `change()` and `flush()` reject; no retry; the document rejects further local edits (peer changes still apply) |

### `Repo.id` and peer IDs

In v2, `peerId` identified both the Repo and its network peer. v3 splits them:

- The **peer ID** belongs to the backend (`backend.peerId`, from Subduction's signer). It is
  authenticated, and several Repos may share it, e.g. browser tabs using one signer.
- **`repo.id`** identifies the Repo instance. It is a random UUID unless set with
  `RepoConfig.id`, must be unique among live Repos, and is not verified.

## New in v3

- `repo.query(id)` observes loading. See [DocumentQuery](#documentquery).
- `repo.flush()` rejects if any write has failed, and keeps rejecting for that document.
- `repo.find(id, { signal })` can be aborted.
- `handle.hasHeads(heads)` checks whether the document contains the given heads.

## Repo

### Usage

- `create<T>(initialValue?)`: creates a document. Resolves once it is stored locally.
- `find<T>(id, { signal }?)`: loads a document locally or from peers. Rejects if it is
  unavailable, fails, or the wait is aborted.
- `query<T>(id)`: observes a document's loading. See [DocumentQuery](#documentquery).
- `import<T>(binary, { docId }?)`: imports an `Automerge.save()` binary. Passing an
  existing `docId` merges into it.
- `export(id)`: exports a document as an Automerge binary.
- `clone(handle)`: copies a document, with its history, under a new ID.
- `delete(id)`: deletes the local copy. _Not deleted on other peers._
- `removeFromCache(id)`: stores, then unloads a document without deleting it.
- `flush(ids?)`: waits until pending writes are stored. Rejects on write failures.
- `shutdown()`: stores pending writes and closes. Logs errors rather than rejecting;
  call `flush()` first if you need them.

`id` may be a document ID or an Automerge URL, including heads or a path.

### Events

```ts
repo.on("document", ({ handle }) => {})
```

- `document` `{ handle }`: a document was created, imported or loaded. Once per load.
- `delete-document` `{ documentId }`: a document was deleted locally.
- `unavailable-document` `{ documentId }`: a document was not found locally or on
  connected peers. It may still arrive later.

## DocHandle

- `doc()`: the current document.
- `change(fn, options?)`: applies an edit. Returns a promise which resolves when the change has been stored locally.
- `changeAt(heads, fn, options?)`: edits as if at `heads`. Resolves with the new heads.
- `heads()`, `history()`, `diff()`, `view(heads)`: as in v2.
- `merge(otherHandle)`: merges another document into this one.
- `sub(...path)`: a handle scoped to a path inside the document. `remove()` deletes it.
- `broadcast(message)`: sends an ephemeral message. See [Ephemeral messages](#ephemeral-messages).

### Events

```ts
const onChange = ({ doc, patches }) => {}
handle.on("change", onChange)
handle.off("change", onChange)
```

- `change` `{ handle, doc, patches, patchInfo, scopeReplaced }`: a local or remote edit.
  On a sub-handle, `doc` and `patches` are scoped to its path, and `scopeReplaced` is
  `true` when the whole subtree was replaced or removed.
- `heads-changed` `{ handle, doc }`: the document's heads changed.
- `delete` `{ handle }`: the document was deleted.
- `ephemeral-message` `{ handle, senderId, originId, message }`: see
  [Ephemeral messages](#ephemeral-messages).
- `remote-heads` `{ peerId, heads, timestamp }`: a peer reported its heads

## DocumentQuery

`repo.query(id)` returns a `DocumentQuery`, and starts loading the document if needed.

- `documentId`: the queried document ID
- `state()`: the current QueryState.
- `subscribe(fn)`: calls `fn` with the current QueryState before returning, then on every
  status change. Returns an unsubscribe function.

```ts
const query = repo.query<{ count: number }>(url)
const unsubscribe = query.subscribe(state => {
  if (state.status === "ready") render(state.handle.doc())
  if (state.status === "failed") console.error(state.error)
})
```

`subscribe` reports loading only, once `ready`, the handle is returned and handle events can be subscribed to for changes.

| Status        | Meaning                                                          |
| ------------- | ---------------------------------------------------------------- |
| `loading`     | Not loaded yet.                                                  |
| `ready`       | `handle` is usable.                                              |
| `unavailable` | Not in storage or on connected peers. May still become `ready`.  |
| `deleted`     | Deleted locally. Final.                                          |
| `failed`      | Backend error or shutdown. Final; a later `find()` starts again. |

`find()` resolves on `ready` and rejects on anything else and uses DocumentQuery under the hood.

## Ephemeral Messages

Ephemeral messages are best-effort and not stored. Each `ephemeral-message` carries
both [IDs](#repoid-and-peer-ids):

- `senderId`: the sending peer's ID, authenticated by the backend.
- `originId`: the sending Repo's `repo.id`.

`Presence` keeps one entry per `originId`;
`getStates()` groups by Repo by default, or by peer with `groupingFn: senderIdentity`.

## Bindings

- [React hooks](../automerge-repo-react-hooks/)
- [Svelte stores](../automerge-repo-svelte-store/)
- [Solid primitives](../automerge-repo-solid-primitives/)

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
