# Automerge Repo

Automerge Repo manages collections of [Automerge](https://github.com/automerge/automerge)
documents. `Repo` provides document lookup and lifecycle management; `DocHandle`
provides document access, mutation, and change events. An optional sedimentree
backend provides local persistence and synchronization.

This branch is an experimental backend proof of concept, not a production-ready
replacement for the released adapter-based implementation. Backend contracts and
integration behavior remain provisional. Legacy network/storage adapters,
templates, and demos have been removed; a legacy backend is deferred.

## Configuration

Pass an initialized backend to `Repo`. Repo owns its backend sessions, orders
each document's local persistence, and closes the backend during shutdown. Do
not share a single-owner backend instance between independently managed Repos.

```ts
import { Repo } from "@automerge/automerge-repo"
import type { SedimentreeBackend } from "@automerge/automerge-repo/sedimentree"

function createRepo(backend: SedimentreeBackend) {
  return new Repo({ backend })
}
```

See [the backend contract](./src/sedimentree/README.md) and
[the Subduction backend](../automerge-repo-subduction/README.md) for configuration,
limitations, and persistence/synchronization semantics. There is no `network`,
`storage`, or `sharePolicy` adapter configuration on this Repo.

`new Repo()` without a backend is local-only: documents created or imported in
that instance are available, but there is no persistent storage or remote lookup.

## Documents

```ts
import { Repo } from "@automerge/automerge-repo"

const repo = new Repo() // Local-only example; configure a backend for persistence.
const handle = await repo.create({ count: 0 })

const persistence = handle.change(doc => {
  doc.count++
})
console.log(handle.doc()?.count) // 1: edits apply immediately.
await persistence

const found = await repo.find<{ count: number }>(handle.url)
const binary = await repo.export(found.url)
if (binary) {
  const imported = await repo.import<{ count: number }>(binary)
  console.log(imported.doc()?.count)
}

try {
  await repo.flush()
} finally {
  await repo.shutdown()
}
```

- `create<T>(initialValue?)` returns `Promise<DocHandle<T>>`. With a backend,
  creation waits for initial history to be locally recoverable, not peer delivery.
- `import<T>(binary, { docId }?)` returns `Promise<DocHandle<T>>`. An explicit
  existing ID merges history rather than replacing it.
- `find<T>(id, { signal }?)` returns `Promise<DocHandle<T>>`, rejecting when the
  document is unavailable, loading fails, or the wait is aborted. Cancellation
  stops this wait, not shared loading. IDs may be document IDs or Automerge URLs,
  including supported heads/path references.
- `handle.doc()` reads the current document. Listen to `handle.on("change", fn)`
  for updates; scoped handles expose the referenced subtree.
- `handle.change(fn, options?)` applies edits immediately and returns
  `Promise<void>` for local persistence of this edit and every earlier local
  edit. Await it to observe failures; it does not promise remote delivery or
  durability. `changeAt(heads, fn, options?)` behaves the same, resolving with
  the new heads. A rejected save does not undo the edit, and is not retried: the
  document then rejects every later local edit with that error, without applying it.
- `clone(handle)` returns `Promise<DocHandle<T>>`, preserving the source history.
- `export(id)` serializes document history as an Automerge binary.
- `delete(id)` returns `Promise<void>` for local deletion, not deletion on peers.
  Existing handles become deleted; a later lookup can reacquire the ID.
- `removeFromCache(id)` drains writes and releases a backend-backed document
  without deleting its history. Without a backend, or after a failed write, it
  rejects, since the handle holds the only copy.
- `flush(documentIds?)` is the backend's persistence barrier: it drains accepted
  local history across documents, including `create()`/`import()`, and rejects
  on persistence failures. A failed write is never forgotten: every later
  `flush()` covering that document rejects with it. It also compacts any due
  fragments first (see below). It is not a remote synchronization barrier.
- `shutdown()` returns `Promise<void>` for idempotent, best-effort teardown.
  It compacts due fragments, then logs failures rather than rejecting them;
  call `flush()` first when persistence errors must be observable.

### Deferred compaction

Edits are stored as loose commits, so `change()` never waits on fragment work.
A commit whose hash starts with a zero byte heads a fragment; once a document
has one with no fragment stored yet, a per-document timer (10 s plus up to 2 s
of jitter, so documents due together spread out) waits for an idle moment, then
bundles every due fragment in one store. `flush()`, `removeFromCache()` and
`shutdown()` compact at once. A failed compaction fails like any other write.
Boundaries received from peers are compacted too. `create()`, `import()` and
`merge()` store their fragments with their commits, since they can bring many
boundaries at once. Due boundaries are learned only while a
document is open; boundaries already in storage without a fragment (for example
after a crash before compaction) are not detected and stay loose.
Nothing is lost either way: loose commits hold the full history.

## Loading Observation

`query(id)` returns a `DocumentQuery` with `state()` and `subscribe()`. It accepts
the same IDs and URLs as `find()` and starts loading if needed. `subscribe()`
calls back synchronously with the current state before returning, then on every
change. States:

- `loading`: no verified snapshot yet.
- `ready`: `handle` is usable (a view or sub-handle for URLs with heads or a path).
- `unavailable`: the backend verified it has no history; may still become `ready`.
- `deleted`: deleted locally. Terminal.
- `failed`: a nonretryable backend error, or shutdown. Terminal; the handle is
  closed and a later `query()`/`find()` starts afresh.

`find(id)` resolves when the query is `ready` and rejects on any other settled
state. Write failures reject the `change()` promise and `flush()`; they do not
change the query. `findWithProgress()` is deprecated in favour of `query()`.

## Ephemeral State

`DocHandle` ephemeral APIs and `Presence` remain available. Ephemeral messages are
best-effort, not persisted, and not recovered by rescanning document history.
Delivery depends on backend support and connected peers.

## Bindings

- [React hooks](../automerge-repo-react-hooks/README.md)
- [Svelte stores](../automerge-repo-svelte-store/README.md)
- [Solid primitives](../automerge-repo-solid-primitives/readme.md)

Await document creation/import before passing its URL to a binding. React/Svelte
updaters return persistence promises; Solid exposes the underlying handle.

## Logging

Enable debug output with `DEBUG=automerge-repo:*`. Use the exported
`setLoggerFactory(namespace => logger)` to supply `debug`, `info`, `warn`, and
`error` methods for application-specific logging.

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
