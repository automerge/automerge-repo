# Solid Automerge

<a href="https://www.solidjs.com/">Solid</a> primitives for <a
href="https://automerge.org/docs/repositories/"> Automerge</a>.

```sh
pnpm add solid-js @automerge/automerge-repo @automerge/automerge-repo-solid-primitives
```

## Changes from v2

You should use `createRepoPrimitives(repo)` rather than directly calling
`useDocHandle`, `RepoProvider` etc.

## Setup

Make the primitives once, next to the Repo, with `createRepoPrimitives`, and import
every primitive from there. They are typed for that Repo, so handles have
[the features its backend adds](../automerge-repo/README.md#extensions), such as
`handle.broadcast` from Subduction:

```tsx
// repo.ts
export const repo = new Repo({ backend })
export const {
  RepoProvider,
  useRepo,
  useDocument,
  useDocSignal,
  useDocHandle,
  createDocumentProjection,
  makeDocumentProjection,
  createDocSignal,
  makeDocSignal,
  autoproduce,
} = createRepoPrimitives(repo)
// If the Repo is made later, give its type instead:
// createRepoPrimitives<Repo<SubductionExtensions>>()

// main.tsx
<RepoProvider value={repo}>
  <App />
</RepoProvider>

// App.tsx: import from "./repo"
const handle = useDocHandle<Todo>(url) // handle()?.broadcast
```

The provider only accepts a Repo of that type, so the two cannot disagree. It also
sets [`RepoContext`](#repocontext). Primitives that find documents throw outside
it, and take no `repo` option. Each `createRepoPrimitives` call makes its own
provider, so an app can use several Repos.

Import the primitives from your `repo.ts`, not from this package: the package
exports primitives of the same names, documented below, and an editor's auto-import
may pick those. They work without the factory, for existing apps and shared
components, but give plain handles.

## useDocument ✨

Get a fine-grained live view of an automerge document from its URL.

When the handle receives changes, it converts the incoming automerge patch ops
to precise solid store updates, giving you fine-grained reactivity that's
consistent across space and time. Fine-grained updates are for Automerge only;
other doc types update coarse-grained, like `useDocSignal`.

Returns `[doc, handle]`.

```ts
useDocument<T>(
    () => AutomergeURL,
    options?: {repo: Repo}
): [Doc<T>, DocHandle<T>]
```

```tsx
// example
const [url, setURL] = createSignal<AutomergeUrl>(props.url)
const [doc, handle] = useDocument(url, { repo })

const inc = () => handle()?.change(d => d.count++)
return <button onclick={inc}>{doc()?.count}</button>
```

The `{repo}` option can be left out if you are using [RepoContext](#repocontext).

## createDocumentProjection

Get a fine-grained live view from a signal automerge `DocHandle`.

Underlying primitive for [`useDocument`](#usedocument-).

Works with [`useHandle`](#usehandle).

```ts
createDocumentProjection<T>(() => AutomergeUrl): Doc<T>
```

```tsx
// example
const handle = repo.find(url)
const doc = makeDocumentProjection<{ items: { title: string }[] }>(handle)

// subscribes fine-grained to doc.items[1].title
return <h1>{doc.items[1].title}</h1>
```

## makeDocumentProjection

Just like `createDocumentProjection`, but without a reactive input.

Underlying primitive for [`createDocumentProjection`](#createDocumentProjection).

```ts
makeDocumentProjection<T>(handle: DocHandle<T>): Doc<T>
```

```tsx
// example
const handle = repo.find(url)
const doc = makeDocumentProjection<{ items: { title: string }[] }>(handle)

// subscribes fine-grained to doc.items[1].title
return <h1>{doc.items[1].title}</h1>
```

## useDocSignal

A light coarse-grained primitive when you care only _that_ a doc has changed,
and not _how_. Returns `[doc, handle]`.

```ts
useDocSignal<T>(
    () => AutomergeURL,
    options?: {repo: Repo}
): [Accessor<Doc<T>>, Resource<DocHandle<T>>]
```

```tsx
// example
const [url, setURL] = createSignal<AutomergeUrl>(props.url)
const [doc, handle] = useDocSignal(url, { repo })

const inc = () => handle()?.change(d => d.count++)
return <button onclick={inc}>{doc()?.count}</button>
```

The `{repo}` option can be left out if you are using [RepoContext](#repocontext).

## createDocSignal

A light coarse-grained primitive when you care only _that_ a doc has changed,
and not _how_. Takes a signal `DocHandle`.

Underlying primitive for [`useDocSignal`](#usedocsignal).

Works with [`useDocHandle`](#usedochandle).

```ts
createDocSignal<T>(() => DocHandle<T>): Accessor<Doc<T>>
```

## makeDocSignal

Just like `createDocSignal`, but without a reactive input.

Underlying primitive for [`createDocSignal`](#createdocsignal).

```ts
makeDocSignal<T>(handle: DocHandle<T>): Accessor<Doc<T>>
```

```tsx
// example
const handle = repo.find(url)
const doc = makeDocSignal<{ count: number }>(handle)

return <span>{doc()?.count}</span>
```

## useDocHandle

Get a [DocHandle](https://automerge.org/docs/repositories/dochandles/) from the
repo as a
[resource](https://docs.solidjs.com/reference/basic-reactivity/create-resource).

Perfect for handing to `createDocumentProjection`.

```ts
useDocHandle<T>(
    () => AnyDocumentId,
    options?: {repo: Repo}
): Resource<DocHandle<T>>
```

```tsx
const handle = useDocHandle(id, { repo })
// or
const handle = useDocHandle(id)
```

The `repo` option can be left out if you are using [RepoContext](#repocontext).

## context

Without the factory, you can pass the repo higher up in your app with
`RepoContext`

### `RepoContext`

A convenience context for Automerge-Repo Solid apps. Optional: if you prefer you
can pass a repo as an option to `useDocHandle` and `useDocument`.

```tsx
<RepoContext.Provider value={repo}>
  <App />
</RepoContext.Provider>
```

### `useRepo`

Get the repo from the [context](#repocontext).

```ts
useRepo(): Repo
```

#### e.g.

```ts
const repo = useRepo()
```

### `usePresence`

This [hook](./src/usePresence.ts) allows temporary state to be shared, such as cursor positions or peer online/offline status.
The handle must support ephemeral messages (a `PresenceHandle`), which depends on the Repo's backend.

```ts
const { peerStates, localState, update, start, stop } = usePresence({
  handle,
  initialState: { cursor: null },
})
```

Ephemeral messages are replicated between peers, but not saved to the Automerge doc, and are used for temporary updates that will be discarded.
