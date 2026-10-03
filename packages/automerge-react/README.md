# @automerge/react

Repo, React hooks, and the experimental Subduction backend in one package.

## React usage

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

Changes apply locally immediately; await a hook updater to observe persistence
failures.

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
storage, initialization and authorization limitations. Browser applications need
the matching native web initializer. For Vite, use
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

`@automerge/react/slim` does not initialize either WASM runtime. Initialize
Automerge and Subduction yourself before creating a backend, using their matching
slim runtime wrappers.
