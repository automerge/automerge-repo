# @automerge/react

Repo, React hooks, and the experimental Subduction backend in one package.

## React usage

The default entrypoint initializes both Automerge and Subduction WASM. A Repo
still has no backend unless one is explicitly supplied. See the
[Automerge Repo quick start](../automerge-repo/README.md#quick-start) for making
a Repo and its backend, and for shutting them down.

Make the hooks once, next to the Repo, with `createRepoHooks`, and import every
hook from there:

```tsx
// repo.ts
import { Repo, createRepoHooks } from "@automerge/react"

export const repo = new Repo({ backend })

export const {
  RepoProvider,
  useRepo,
  useDocument,
  useDocuments,
  useDocHandle,
  useDocHandles,
  usePresence,
} = createRepoHooks(repo)
// If the Repo is made later, give its type instead:
// createRepoHooks<Repo<SubductionExtensions>>()
```

```tsx
// App.tsx
import { Suspense } from "react"
import type { AutomergeUrl } from "@automerge/react"
import { RepoProvider, repo, useDocument } from "./repo"

type CounterDoc = { count: number }

function Counter({ url }: { url: AutomergeUrl }) {
  const [doc, change] = useDocument<CounterDoc>(url, { suspense: true })
  return (
    <button
      onClick={() => {
        void change(value => {
          value.count++
        }).catch(console.error)
      }}
    >
      {doc.count}
    </button>
  )
}

const handle = await repo.create<CounterDoc>({ count: 0 })

export function App() {
  return (
    <RepoProvider value={repo}>
      <Suspense fallback="Loading...">
        <Counter url={handle.url} />
      </Suspense>
    </RepoProvider>
  )
}
```

Changes apply locally immediately; await a hook updater to observe persistence
failures.

The hooks are typed for that Repo, so their handles have
[the features its backend adds](../automerge-repo/README.md#extensions):

```tsx
const handle = useDocHandle<CounterDoc>(url, { suspense: true })
handle.broadcast("hello") // if the backend has ephemeral messages
```

The provider only accepts a Repo of the type the hooks were made for, so the two
cannot disagree, and the hooks that use the Repo throw outside it. Each
`createRepoHooks` call makes its own provider, so an app can use several Repos,
each with its own hooks.

Import `useDocument`, `useDocHandle` and the rest from your `repo.ts`, not from
`@automerge/react`: the package exports hooks of the same names (see below), and an
editor's auto-import may pick those. To catch this, a lint rule can forbid them in
app code, e.g. with ESLint or oxlint:

```json
"no-restricted-imports": ["error", {
  "paths": [{
    "name": "@automerge/react",
    "importNames": ["useRepo", "useDocument", "useDocuments", "useDocHandle",
      "useDocHandles", "usePresence"],
    "message": "Import hooks from ./repo (createRepoHooks)."
  }]
}]
```

### Without the factory

The package also exports the hooks directly, for existing apps and for shared
components that work with any Repo. They read the Repo from `RepoContext`, which
the factory's provider also sets:

```tsx
import { RepoContext, useDocument } from "@automerge/react"

export function App() {
  return (
    <RepoContext.Provider value={repo}>
      <Counter url={url} />
    </RepoContext.Provider>
  )
}
```

These give plain handles, without the features the backend adds.
`useRepo<typeof repo>()` names the Repo's type without checking it.

## Subduction

The package re-exports the
[Subduction backend](../automerge-repo-subduction/README.md), its
[IndexedDB storage adapter](../automerge-repo-subduction-storage-indexeddb/README.md)
and its
[WebSocket network adapter](../automerge-repo-subduction-network-websocket/README.md).
See their READMEs for setup, shutdown, browser bundler configuration and
limitations.

## Slim entrypoint

`@automerge/react/slim` does not initialize either WASM runtime. Initialize
Automerge and Subduction yourself before creating a backend, using their matching
slim runtime wrappers.
