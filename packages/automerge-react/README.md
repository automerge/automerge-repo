# @automerge/react

Repo and React hooks in one package.

## Changes from v2

When creating a hook you should use `createRepoHooks(repo)` rather than
directly calling `useDocHandle` etc.

## React usage

The package has no backend of its own: install one, such as the
[Subduction backend](../automerge-repo-subduction/README.md), and pass it to the
Repo. See the [Automerge Repo quick start](../automerge-repo/README.md#quick-start)
for making a Repo and its backend, and for shutting them down.

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
// If the Repo is made later, give its type instead, e.g. for Subduction:
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

The hooks are typed for that Repo, so their handles have
[the features its backend adds](../automerge-repo/README.md#extensions):

```tsx
const handle = useDocHandle<CounterDoc>(url, { suspense: true })
handle.broadcast("hello") // if the backend has ephemeral messages
```

Each `createRepoHooks` call makes its own provider, so an app can use several Repos,
each with its own hooks.

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

If you want to make sure you always use the typed hooks, you can add the following lint rule:

```json
"no-restricted-imports": ["error", {
  "paths": [{
    "name": "@automerge/react",
    "importNames": ["useRepo", "useDocument", "useDocuments", "useDocHandle", "useDocHandles", "usePresence"]
  }]
}]
```

## Slim entrypoint

The default entrypoint initializes Automerge's WASM. `@automerge/react/slim` does
not: initialize Automerge yourself before creating a Repo.
