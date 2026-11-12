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

## Typed handles

A backend can add features to every handle of its Repo, such as the Subduction
backend's ephemeral messaging (`handle.broadcast`). `RepoContext` only knows a plain
`Repo`, so hooks reading it return plain handles unless told the Repo's type. There are
three ways to tell them.

**Recommended: hooks made for your Repo.** `createRepoHooks` infers the type from the
Repo, and its provider only accepts a Repo of that type, so the two cannot disagree:

```tsx
// repo.ts
export const repo = new Repo({ backend })
export const { RepoProvider, useRepo, useDocHandle, useDocHandles } =
  createRepoHooks(repo)
// If the Repo is made later, give its type: createRepoHooks<AppRepo>()

// main.tsx
<RepoProvider value={repo}>
  <App />
</RepoProvider>

// App.tsx: import these hooks from "./repo"; the rest from "@automerge/react".
const handle = useDocHandle<Todo>(url, { suspense: true }) // has broadcast
```

The provider also sets `RepoContext`, so the package's other hooks keep working. Its
hooks throw outside a `RepoProvider`.

**Per call: a handle type.** Name your handles from the Repo, and pass that type in
place of the document type:

```ts
export type AppHandle<T> = HandleOf<typeof repo, T>

const handle = useDocHandle<AppHandle<Todo>>(url)
const repo = useRepo<typeof repo>()
```

**Once per app: register the Repo's type.** Then plain calls are typed:

```ts
declare module "@automerge/react" {
  interface Register {
    repo: typeof repo
  }
}

const handle = useDocHandle<Todo>(url) // has broadcast
```

The last two assert what the Repo in `RepoContext` is; nothing checks it. A handle type
given per call overrides a registration. A registration applies to the whole program,
so only apps should register.

## Subduction and browser storage

```ts
import {
  Repo,
  SubductionBackend,
  IndexedDBSubductionStorageAdapter,
  WebSocketSubductionNetworkAdapter,
} from "@automerge/react"

const storage = new IndexedDBSubductionStorageAdapter({ database: "my-app" })
const backend = new SubductionBackend({
  storage,
  network: [new WebSocketSubductionNetworkAdapter("ws://127.0.0.1:8080")],
})
const repo = new Repo({ backend })
const handle = await repo.create({ todos: [] })
// Keep the Repo/backend/store alive while the app uses the handle.

try {
  await repo.flush()
} finally {
  try {
    await repo.shutdown()
  } finally {
    try {
      await backend.close()
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
