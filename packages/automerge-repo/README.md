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

Pass an initialized backend to `Repo`. The Repo scheduler owns its sessions,
orders local persistence, and closes the backend during shutdown. Do not share a
single-owner backend instance between independently managed Repos.

```ts
import { Repo } from "@automerge/automerge-repo"
import type { SedimentreeBackend } from "@automerge/automerge-repo/sedimentree"

function createRepo(backend: SedimentreeBackend) {
  return new Repo({ backend, flushConcurrency: 20 })
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
  `Promise<void>` for local persistence. Await it to observe failures; it does not
  promise remote delivery or durability.
- `export(id)` serializes document history as an Automerge binary.
- `delete(id)` returns `Promise<void>` for local deletion, not deletion on peers.
- `flush(documentIds?)` drains/retries accepted local history and rejects on
  persistence failures. It is not a remote synchronization barrier.
- `shutdown()` returns `Promise<void>` for idempotent, best-effort teardown.
  Shutdown logs failures rather than rejecting them; call `flush()` first when
  persistence errors must be observable.

## Loading Observation

`findWithProgress()` is deprecated. Prefer `find()` for promise-based loading.
A replacement query API is deferred. Existing loading observers can still use
`peek()`, `subscribe()`, and `whenReady()`; synchronous initial-value peeks remain
in the React and Solid bindings to avoid loading flicker.

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
