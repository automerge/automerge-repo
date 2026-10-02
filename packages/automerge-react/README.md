# @automerge/react

Convenience exports for Automerge Repo, React hooks, and the Subduction backend.
This branch is experimental: Subduction is still a private workspace package with
a local native dependency. The umbrella is private until that dependency can be
published; do not use it as a registry installation yet.

## Local-only React usage

The default entrypoint initializes both Automerge and Subduction WASM. A Repo
still has no backend unless one is explicitly supplied.

```tsx
import { Suspense } from "react"
import {
  Repo,
  RepoContext,
  useDocument,
  type AutomergeUrl,
} from "@automerge/react"

const repo = new Repo()
const handle = await repo.create({ count: 0 })

function Counter({ url }: { url: AutomergeUrl }) {
  const [doc, change] = useDocument<{ count: number }>(url, { suspense: true })
  return (
    <button
      onClick={() => {
        void change(value => {
          value.count++
        }).catch(console.error)
      }}
    >
      {doc?.count}
    </button>
  )
}

export function App() {
  return (
    <RepoContext.Provider value={repo}>
      <Suspense fallback="Loading...">
        <Counter url={handle.url} />
      </Suspense>
    </RepoContext.Provider>
  )
}
```

`create()`, `import()` and `clone()` return handle promises. Changes apply locally
immediately, but `handle.change()` and hook updaters return local-persistence
promises. There is no automatic server, adapter configuration or `createRepo()`
factory.

## Subduction and browser storage

```ts
import {
  Repo,
  createSubductionPeer,
  IndexedDBByteStore,
} from "@automerge/react"

const storage = new IndexedDBByteStore({ database: "my-app" })
const peer = createSubductionPeer({ storage, servers: ["ws://127.0.0.1:8080"] })
const repo = new Repo({ backend: peer.backend })
const handle = await repo.create({ todos: [] })
// Keep the Repo/peer/store alive while the app uses the handle.

try {
  await repo.flush()
} finally {
  try {
    await repo.shutdown()
  } finally {
    try {
      await peer.close()
    } finally {
      await storage.close()
    }
  }
}
```

Use one live backend per IndexedDB database, including across tabs. The default
signer is temporary; IndexedDB does not persist peer identity. See the
[Subduction README](../automerge-repo-subduction/README.md) for connection,
storage, initialization and authorization limitations. Browser applications using
the linked native build need its matching web initializer. For Vite, use
`vite-plugin-wasm`, exclude the Automerge/Repo/Subduction packages from dependency
optimization, and add this alias to the Vite configuration:

```ts
import { fileURLToPath } from "node:url"

const alias = {
  find: /^@automerge\/subduction$/,
  replacement: fileURLToPath(
    new URL("./web.js", import.meta.resolve("@automerge/subduction"))
  ),
}
```

## Slim entrypoint

`@automerge/react/slim` exports the same Repo, hook and backend APIs plus
Automerge's explicit initialization helpers, without initializing either WASM
runtime. Initialize Automerge and Subduction yourself before creating a backend,
using their matching slim runtime wrappers. See each runtime's initialization
instructions. Importing or constructing `IndexedDBByteStore` does not open a
database until its first operation.

## Exports

- Repo and document APIs from `@automerge/automerge-repo`.
- All hooks and `RepoContext` from `@automerge/automerge-repo-react-hooks`.
- Subduction backend, connection/peer helpers, byte stores, and their types from
  `@automerge/automerge-repo-subduction`.

Legacy network/storage adapters are not re-exported or reinstated.
